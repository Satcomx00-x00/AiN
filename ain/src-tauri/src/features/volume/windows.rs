//! Windows Core Audio: the default output device's volume and peak meter, and a mixer over every
//! active output device and the app sessions playing on them.

use std::collections::BTreeMap;

use windows::{
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Foundation::{CloseHandle, S_OK},
        Media::Audio::{
            AudioSessionStateActive, AudioSessionStateExpired, DEVICE_STATE_ACTIVE,
            Endpoints::{IAudioEndpointVolume, IAudioMeterInformation},
            IAudioSessionControl, IAudioSessionControl2, IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator, ISimpleAudioVolume,
            MMDeviceEnumerator, eMultimedia, eRender,
        },
        System::{
            Com::{CLSCTX_ALL, CoCreateInstance, CoTaskMemFree, STGM_READ, StructuredStorage::PropVariantToStringAlloc},
            Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
        },
    },
    core::{HSTRING, Interface, PWSTR},
};

use super::{
    Backend, Change, Output, Source, SourceKind,
    mixer::{app_identity, round_level, sort},
};

const SYSTEM_SOUNDS: (&str, &str) = ("app:system", "System sounds");
/// Windows' audio engine shows up as a session but isn't something to mix.
const HIDDEN: &[&str] = &["app:audiodg"];

pub struct Endpoint {
    enumerator: IMMDeviceEnumerator,
    id: String,
    device: String,
    volume: IAudioEndpointVolume,
    meter: IAudioMeterInformation,
}

/// Copies a COM-allocated string and frees it.
fn take(s: PWSTR) -> String {
    // SAFETY: `s` was allocated by COM for us; we read it once, then hand it back.
    unsafe {
        let text = s.to_string().unwrap_or_default();
        CoTaskMemFree(Some(s.0 as _));
        text
    }
}

fn device_id(device: &IMMDevice) -> Option<String> {
    // SAFETY: a getter on a live device.
    unsafe { device.GetId().ok().map(take) }
}

fn default_device(enumerator: &IMMDeviceEnumerator) -> Option<(IMMDevice, String)> {
    // SAFETY: plain COM calls on a live enumerator from the thread that created it.
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia).ok()? };
    let id = device_id(&device)?;
    Some((device, id))
}

fn friendly_name(device: &IMMDevice) -> String {
    // SAFETY: COM calls on a live device; the PROPVARIANT string is copied and freed by `take`.
    unsafe {
        device
            .OpenPropertyStore(STGM_READ)
            .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
            .and_then(|value| PropVariantToStringAlloc(&value))
            .map(take)
            .unwrap_or_default()
    }
}

/// The executable path of a process, if we may look at it.
fn process_path(pid: u32) -> Option<String> {
    // SAFETY: a limited-information handle, closed before returning; the buffer outlives the call.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// An app's session on some device: its id and label, whether it's playing, and its volume.
struct Session {
    id: String,
    name: String,
    active: bool,
    volume: ISimpleAudioVolume,
}

/// Every live app session on every active output device (our own excluded).
fn sessions(enumerator: &IMMDeviceEnumerator) -> Vec<Session> {
    let ours = std::process::id();
    let mut out = Vec::new();
    // SAFETY: COM calls on live objects from the worker thread that created them.
    unsafe {
        let Ok(devices) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return out };
        for i in 0..devices.GetCount().unwrap_or(0) {
            let Ok(device) = devices.Item(i) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(list) = manager.GetSessionEnumerator() else { continue };
            for j in 0..list.GetCount().unwrap_or(0) {
                let Ok(control) = list.GetSession(j) else { continue };
                if let Some(s) = session(&control, ours) {
                    out.push(s);
                }
            }
        }
    }
    out
}

fn session(control: &IAudioSessionControl, ours: u32) -> Option<Session> {
    // SAFETY: COM calls on a live session control.
    unsafe {
        let state = control.GetState().ok()?;
        if state == AudioSessionStateExpired {
            return None;
        }
        let control2: IAudioSessionControl2 = control.cast().ok()?;
        let (id, name) = if control2.IsSystemSoundsSession() == S_OK {
            (SYSTEM_SOUNDS.0.to_string(), SYSTEM_SOUNDS.1.to_string())
        } else {
            let pid = control2.GetProcessId().ok()?;
            if pid == ours {
                return None;
            }
            app_identity(&process_path(pid)?)
        };
        if HIDDEN.contains(&id.as_str()) {
            return None;
        }
        Some(Session { id, name, active: state == AudioSessionStateActive, volume: control.cast().ok()? })
    }
}

fn set_endpoint(volume: &IAudioEndpointVolume, change: Change) {
    // SAFETY: setters on a live endpoint volume, called from its own thread.
    unsafe {
        let _ = match change {
            Change::Level(level) => volume.SetMasterVolumeLevelScalar(level, std::ptr::null()),
            Change::Muted(muted) => volume.SetMute(muted, std::ptr::null()),
        };
    }
}

impl Endpoint {
    pub fn new() -> Option<Self> {
        // SAFETY: COM is initialized on this worker thread (see `platform::init_thread`).
        let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.ok()?;
        Self::bind(enumerator)
    }

    fn bind(enumerator: IMMDeviceEnumerator) -> Option<Self> {
        let (device, id) = default_device(&enumerator)?;
        // SAFETY: activating endpoint interfaces on a live device from its thread.
        let (volume, meter) = unsafe { (device.Activate(CLSCTX_ALL, None).ok()?, device.Activate(CLSCTX_ALL, None).ok()?) };
        Some(Self { device: friendly_name(&device), enumerator, id, volume, meter })
    }

    /// Changes one source: a device by its endpoint id, or every session of an app.
    fn apply_to(&self, id: &str, change: Change) {
        if let Some(device) = id.strip_prefix("device:") {
            // SAFETY: COM calls on live objects from the worker thread.
            let volume = unsafe {
                self.enumerator.GetDevice(&HSTRING::from(device)).and_then(|d| d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None))
            };
            if let Ok(v) = volume {
                set_endpoint(&v, change);
            }
            return;
        }
        for s in sessions(&self.enumerator).into_iter().filter(|s| s.id == id) {
            // SAFETY: setters on a live session volume.
            unsafe {
                let _ = match change {
                    Change::Level(level) => s.volume.SetMasterVolume(level, std::ptr::null()),
                    Change::Muted(muted) => s.volume.SetMute(muted, std::ptr::null()),
                };
            }
        }
    }
}

impl Backend for Endpoint {
    /// Rebinds when the user switched outputs; false once the default device is gone.
    fn refresh(&mut self) -> bool {
        match default_device(&self.enumerator) {
            Some((_, id)) if id == self.id => true,
            Some(_) => match Self::bind(self.enumerator.clone()) {
                Some(ep) => {
                    *self = ep;
                    true
                }
                None => false,
            },
            None => false,
        }
    }

    fn read(&mut self) -> Option<(Output, f32)> {
        // SAFETY: getters on live endpoint interfaces, called from their own thread.
        unsafe {
            let level = round_level(self.volume.GetMasterVolumeLevelScalar().ok()?);
            let muted = self.volume.GetMute().ok()?.as_bool();
            let peak = self.meter.GetPeakValue().unwrap_or(0.0);
            Some((Output { level, muted, device: self.device.clone() }, peak))
        }
    }

    /// A source by id, or the default output device for `None`.
    fn apply(&mut self, source: Option<&str>, change: Change) {
        match source {
            Some(id) => self.apply_to(id, change),
            None => set_endpoint(&self.volume, change),
        }
    }

    /// Every active output device, then every app with audio sessions (grouped by executable).
    fn sources(&mut self) -> Vec<Source> {
        let mut out = Vec::new();
        // SAFETY: COM calls on live objects from the worker thread.
        unsafe {
            if let Ok(devices) = self.enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) {
                for i in 0..devices.GetCount().unwrap_or(0) {
                    let Ok(device) = devices.Item(i) else { continue };
                    let (Some(id), Ok(volume)) = (device_id(&device), device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)) else {
                        continue;
                    };
                    out.push(Source {
                        default: id == self.id,
                        id: format!("device:{id}"),
                        kind: SourceKind::Device,
                        name: friendly_name(&device),
                        level: round_level(volume.GetMasterVolumeLevelScalar().unwrap_or(0.0)),
                        muted: volume.GetMute().is_ok_and(|m| m.as_bool()),
                        active: true,
                    });
                }
            }
            let mut apps: BTreeMap<String, Source> = BTreeMap::new();
            for s in sessions(&self.enumerator) {
                let level = round_level(s.volume.GetMasterVolume().unwrap_or(0.0));
                let muted = s.volume.GetMute().is_ok_and(|m| m.as_bool());
                apps.entry(s.id.clone()).and_modify(|a| a.active |= s.active).or_insert(Source {
                    id: s.id,
                    kind: SourceKind::App,
                    name: s.name,
                    level,
                    muted,
                    default: false,
                    active: s.active,
                });
            }
            out.extend(apps.into_values());
        }
        sort(&mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::{Backend, Endpoint};

    #[test]
    #[ignore = "reads this machine's live audio output"]
    fn smoke_reads_output() {
        crate::platform::init_thread();
        let mut ep = Endpoint::new().expect("default output device");
        println!("output: {:?}", ep.read());
        for s in ep.sources() {
            println!("source: {:?} {} level={} muted={} default={} active={}", s.kind, s.name, s.level, s.muted, s.default, s.active);
        }
    }
}
