//! Core Audio lists the processes using audio and whether each records (macOS 14 and later; before
//! that, only whether the microphone is in use at all). For cameras, Core Media IO only tells
//! whether one is in use, not by whom.

use std::{
    ffi::{c_char, c_void},
    mem,
    path::Path,
    ptr,
};

use super::Usage;
use crate::platform::macos::audio::{
    self, Address, DEFAULT_INPUT, GLOBAL, INPUT, MAIN, PROCESS_PID, PROCESS_RUNNING_INPUT, PROCESSES, RUNNING_SOMEWHERE, SYSTEM,
};

/// Shown when the system tells that a device is in use but not by which app.
const SOMEONE: &str = "An app";

pub fn read() -> Usage {
    Usage { mic: recording(), camera: filming() }
}

fn recording() -> Vec<String> {
    let processes = Address::global(PROCESSES);
    if !audio::has(audio::SYSTEM, processes) {
        let mic = audio::get::<audio::ObjectId>(SYSTEM, Address::global(DEFAULT_INPUT)).unwrap_or(0);
        let busy = mic != 0 && audio::get::<u32>(mic, Address::new(RUNNING_SOMEWHERE, INPUT, MAIN)).unwrap_or(0) != 0;
        return if busy { vec![SOMEONE.into()] } else { Vec::new() };
    }
    let mut apps: Vec<String> = audio::objects(SYSTEM, processes)
        .into_iter()
        .filter(|&p| audio::get::<u32>(p, Address::global(PROCESS_RUNNING_INPUT)).unwrap_or(0) != 0)
        .filter_map(|p| audio::get::<i32>(p, Address::global(PROCESS_PID)))
        .map(|pid| process_path(pid).map_or_else(|| format!("Process {pid}"), |path| app_name(&path)))
        .collect();
    apps.sort();
    apps.dedup();
    apps
}

unsafe extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_void, size: u32) -> i32;
}

/// `PROC_PIDPATHINFO_MAXSIZE`.
const PATH_MAX: usize = 4096;

fn process_path(pid: i32) -> Option<String> {
    let mut buffer = vec![0u8; PATH_MAX];
    // SAFETY: the buffer holds the size we pass.
    let len = unsafe { proc_pidpath(pid, buffer.as_mut_ptr().cast::<c_char>().cast(), PATH_MAX as u32) };
    let len = usize::try_from(len).ok().filter(|&n| n > 0)?;
    Some(String::from_utf8_lossy(&buffer[..len]).into_owned())
}

/// The app a program belongs to: its outermost `.app` bundle, so a browser's helper processes count
/// as the browser. "/Applications/Google Chrome.app/…/Google Chrome Helper.app/…" → "Google Chrome".
pub fn app_name(path: &str) -> String {
    let path = Path::new(path);
    path.components()
        .filter_map(|c| c.as_os_str().to_str())
        .find_map(|c| c.strip_suffix(".app"))
        .or_else(|| path.file_name().and_then(|n| n.to_str()))
        .unwrap_or_default()
        .to_string()
}

#[repr(C)]
struct CmioAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreMediaIO", kind = "framework")]
unsafe extern "C" {
    fn CMIOObjectGetPropertyDataSize(
        object: u32,
        address: *const CmioAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
    ) -> i32;
    fn CMIOObjectGetPropertyData(
        object: u32,
        address: *const CmioAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: u32,
        used: *mut u32,
        data: *mut c_void,
    ) -> i32;
}

/// `kCMIOObjectSystemObject`.
const CMIO_SYSTEM: u32 = 1;
const CMIO_DEVICES: CmioAddress = CmioAddress { selector: u32::from_be_bytes(*b"dev#"), scope: GLOBAL, element: MAIN };
const CMIO_RUNNING_SOMEWHERE: CmioAddress = CmioAddress { selector: RUNNING_SOMEWHERE, scope: GLOBAL, element: MAIN };

fn cameras() -> Vec<u32> {
    let mut size = 0u32;
    // SAFETY: `size` is valid for the call.
    if unsafe { CMIOObjectGetPropertyDataSize(CMIO_SYSTEM, &CMIO_DEVICES, 0, ptr::null(), &mut size) } != 0 {
        return Vec::new();
    }
    let mut ids = vec![0u32; size as usize / mem::size_of::<u32>()];
    let mut used = 0u32;
    // SAFETY: `ids` has room for `size` bytes.
    let status = unsafe { CMIOObjectGetPropertyData(CMIO_SYSTEM, &CMIO_DEVICES, 0, ptr::null(), size, &mut used, ids.as_mut_ptr().cast()) };
    if status != 0 {
        return Vec::new();
    }
    ids.truncate(used as usize / mem::size_of::<u32>());
    ids
}

fn filming() -> Vec<String> {
    let busy = cameras().into_iter().any(|camera| {
        let (mut running, mut used) = (0u32, 0u32);
        // SAFETY: `running` holds the 4 bytes we pass.
        let status =
            unsafe { CMIOObjectGetPropertyData(camera, &CMIO_RUNNING_SOMEWHERE, 0, ptr::null(), 4, &mut used, (&raw mut running).cast()) };
        status == 0 && running != 0
    });
    if busy { vec![SOMEONE.into()] } else { Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_app_a_process_belongs_to() {
        assert_eq!(
            app_name(
                "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"
            ),
            "Google Chrome"
        );
        assert_eq!(app_name("/Applications/zoom.us.app/Contents/MacOS/zoom.us"), "zoom.us");
        assert_eq!(app_name("/usr/local/bin/sox"), "sox");
    }

    #[test]
    #[ignore = "reads this machine's live devices"]
    fn smoke_reads_usage() {
        println!("usage: {:?}", read());
    }
}
