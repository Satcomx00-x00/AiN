//! Volume: the default output (for the pop-up on volume keys), plus a mixer of every source —
//! active output devices and the apps playing on them — each with its level and mute.
//! Windows uses Core Audio (`windows.rs`), Linux the PulseAudio API PipeWire provides (`linux.rs`).

#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(windows, target_os = "linux"))]
mod mixer;
#[cfg(windows)]
mod windows;

use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State, Wry, plugin::TauriPlugin};
use tauri_specta::Event;

use super::{live::Live, worker::Worker};
use crate::Res;

/// Fast enough that the collapsed pill reacts to volume keys right away.
const POLL: Duration = Duration::from_millis(100);
/// Polls between checks for a new default output device (~2 s).
const DEVICE_CHECK_EVERY: u32 = 20;
/// Polls between mixer refreshes (~1 s); enumerating every session is heavier than one volume read.
const SOURCES_EVERY: u32 = 10;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Output {
    /// 0–1, rounded to whole percent so tiny float noise doesn't count as a change.
    pub level: f32,
    pub muted: bool,
    pub device: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Device,
    App,
}

/// Something with its own volume: an output device, or an app (all its audio streams together).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Source {
    /// "device:<device id>" or "app:<program name, lowercase>".
    pub id: String,
    pub kind: SourceKind,
    pub name: String,
    pub level: f32,
    pub muted: bool,
    /// The default output device.
    pub default: bool,
    /// For apps: currently making sound.
    pub active: bool,
}

/// The default output now (none when unavailable), sent whenever it changes.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct OutputChanged(pub Option<Output>);

/// Every mixable source, sent whenever the list or a level changes.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SourcesChanged(pub Vec<Source>);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Change {
    Level(f32),
    Muted(bool),
}

/// A change for one source; `None` targets the default output device.
#[derive(Debug, Clone, PartialEq)]
pub struct Command {
    pub source: Option<String>,
    pub change: Change,
}

/// A platform's audio API, owned by the worker thread.
pub trait Backend {
    /// The default output and how loud it is right now (0–1).
    fn read(&mut self) -> Option<(Output, f32)>;
    /// Every device and app, sorted for display.
    fn sources(&mut self) -> Vec<Source>;
    /// Changes one source by id, or the default output for `None`.
    fn apply(&mut self, source: Option<&str>, change: Change);
    /// Follows a new default device; false when the backend is gone and should be reopened.
    fn refresh(&mut self) -> bool;
}

/// The worker's backend, when it has one.
type Slot = Option<Box<dyn Backend>>;

/// This platform's backend, or `None` where there is none (or no audio device right now).
fn open() -> Slot {
    #[cfg(windows)]
    return windows::Endpoint::new().map(|e| Box::new(e) as Box<dyn Backend>);
    #[cfg(target_os = "linux")]
    return linux::Pulse::new().map(|p| Box::new(p) as Box<dyn Backend>);
    #[cfg(not(any(windows, target_os = "linux")))]
    None
}

#[derive(Default)]
struct Shared {
    output: Live<Option<Output>>,
    peak: Live<f32>,
    sources: Live<Vec<Source>>,
}

/// What changed in one poll, to announce.
#[derive(Debug, Default, PartialEq)]
struct Changes {
    output: Option<Option<Output>>,
    sources: Option<Vec<Source>>,
}

impl Shared {
    /// One worker tick (`polls` counts them): follows a new default device, reopening the backend
    /// when it's gone; applies `command`; re-reads the output, and the sources after a command or
    /// every `SOURCES_EVERY` polls. With no backend, there is no output and nothing to mix.
    fn poll(&self, backend: &mut Slot, open: impl Fn() -> Slot, polls: u32, command: Option<Command>) -> Changes {
        if polls.is_multiple_of(DEVICE_CHECK_EVERY) && !backend.as_mut().is_some_and(|b| b.refresh()) {
            *backend = open();
        }
        let Some(b) = backend.as_mut() else {
            self.peak.set(0.0);
            return Changes { output: self.output.set(None).then_some(None), sources: self.sources.set(Vec::new()).then(Vec::new) };
        };
        let commanded = command.is_some();
        if let Some(Command { source, change }) = command {
            b.apply(source.as_deref(), change);
        }
        let (output, peak) = b.read().map_or((None, 0.0), |(o, p)| (Some(o), p));
        self.peak.set(peak);
        let output = self.output.set(output.clone()).then_some(output);
        let sources = (commanded || polls.is_multiple_of(SOURCES_EVERY)).then(|| b.sources()).filter(|s| self.sources.set(s.clone()));
        Changes { output, sources }
    }
}

struct Volume {
    shared: Arc<Shared>,
    worker: Worker<Command>,
}

#[tauri::command]
#[specta::specta]
fn state(volume: State<'_, Volume>) -> Option<Output> {
    volume.shared.output.get()
}

/// Current loudness of the default output, 0–1 (always 0 where the OS has no cheap meter).
#[tauri::command]
#[specta::specta]
fn peak(volume: State<'_, Volume>) -> f32 {
    volume.shared.peak.get()
}

/// Every source that can be mixed.
#[tauri::command]
#[specta::specta]
fn sources(volume: State<'_, Volume>) -> Vec<Source> {
    volume.shared.sources.get()
}

#[tauri::command]
#[specta::specta]
fn set_level(volume: State<'_, Volume>, source: Option<String>, level: f32) -> Res<()> {
    volume.worker.send(Command { source, change: Change::Level(level.clamp(0.0, 1.0)) })
}

#[tauri::command]
#[specta::specta]
fn set_muted(volume: State<'_, Volume>, source: Option<String>, muted: bool) -> Res<()> {
    volume.worker.send(Command { source, change: Change::Muted(muted) })
}

fn spawn(app: AppHandle, shared: Arc<Shared>) -> std::io::Result<Worker<Command>> {
    let mut polls = 0u32;
    super::worker::spawn("volume", POLL, open, move |backend, command: Option<Command>| {
        polls = polls.wrapping_add(1);
        let changes = shared.poll(backend, open, polls, command);
        if let Some(output) = changes.output {
            let _ = OutputChanged(output).emit(&app);
        }
        if let Some(sources) = changes.sources {
            let _ = SourcesChanged(sources).emit(&app);
        }
    })
}

crate::ipc::volume!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let shared = Arc::new(Shared::default());
        let worker = spawn(app.clone(), Arc::clone(&shared))?;
        app.manage(Volume { shared, worker });
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A backend that records calls and reads back what it was set to.
    struct Fake {
        log: Arc<Mutex<Vec<String>>>,
        level: f32,
        healthy: bool,
    }

    impl Backend for Fake {
        fn read(&mut self) -> Option<(Output, f32)> {
            self.log.lock().unwrap().push("read".into());
            Some((Output { level: self.level, muted: false, device: "Speakers".into() }, 0.3))
        }
        fn sources(&mut self) -> Vec<Source> {
            self.log.lock().unwrap().push("sources".into());
            vec![Source {
                id: "device:1".into(),
                kind: SourceKind::Device,
                name: "Speakers".into(),
                level: self.level,
                muted: false,
                default: true,
                active: true,
            }]
        }
        fn apply(&mut self, source: Option<&str>, change: Change) {
            self.log.lock().unwrap().push(format!("apply {source:?}"));
            if let Change::Level(level) = change {
                self.level = level;
            }
        }
        fn refresh(&mut self) -> bool {
            self.healthy
        }
    }

    fn fake(level: f32, healthy: bool) -> (Slot, Arc<Mutex<Vec<String>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        (Some(Box::new(Fake { log: Arc::clone(&log), level, healthy })), log)
    }

    const NEVER: fn() -> Slot = || panic!("reopened without reason");

    #[test]
    fn applies_a_command_before_reading_and_refreshes_the_mixer_at_once() {
        let shared = Shared::default();
        let (mut backend, log) = fake(0.2, true);
        let command = Command { source: None, change: Change::Level(0.6) };
        let changes = shared.poll(&mut backend, NEVER, 1, Some(command));
        assert_eq!(*log.lock().unwrap(), ["apply None", "read", "sources"]);
        assert_eq!(changes.output.flatten().map(|o| o.level), Some(0.6));
        assert_eq!(changes.sources.map(|s| s[0].level), Some(0.6));
        assert_eq!(shared.peak.get(), 0.3);
    }

    #[test]
    fn announces_only_what_changed_and_lists_sources_only_now_and_then() {
        let shared = Shared::default();
        let (mut backend, log) = fake(0.5, true);
        assert!(shared.poll(&mut backend, NEVER, 1, None).output.is_some(), "the first reading is news");
        assert_eq!(shared.poll(&mut backend, NEVER, 2, None), Changes::default());
        assert!(!log.lock().unwrap().contains(&"sources".to_string()));
        let changes = shared.poll(&mut backend, NEVER, SOURCES_EVERY, None);
        assert!(changes.sources.is_some(), "the mixer is re-read every SOURCES_EVERY polls");
        assert_eq!(shared.poll(&mut backend, NEVER, SOURCES_EVERY * 2, None), Changes::default(), "same sources: nothing to say");
    }

    #[test]
    fn reopens_a_lost_backend_on_the_device_check() {
        let shared = Shared::default();
        let (mut backend, _) = fake(0.5, false);
        shared.poll(&mut backend, NEVER, 1, None);
        let (fresh, fresh_log) = fake(0.9, true);
        let fresh = Mutex::new(fresh);
        let changes = shared.poll(&mut backend, || fresh.lock().unwrap().take(), DEVICE_CHECK_EVERY, None);
        assert_eq!(changes.output.flatten().map(|o| o.level), Some(0.9));
        assert!(fresh_log.lock().unwrap().contains(&"read".to_string()));
    }

    #[test]
    fn with_no_backend_left_the_output_goes_away_instead_of_going_stale() {
        let shared = Shared::default();
        let (mut backend, _) = fake(0.5, false);
        shared.poll(&mut backend, NEVER, SOURCES_EVERY, None);
        assert!(shared.output.get().is_some() && !shared.sources.get().is_empty());
        let changes = shared.poll(&mut backend, || None, DEVICE_CHECK_EVERY, None);
        assert_eq!(changes, Changes { output: Some(None), sources: Some(Vec::new()) });
        assert!(backend.is_none());
        assert_eq!(shared.poll(&mut backend, || None, DEVICE_CHECK_EVERY + 1, None), Changes::default(), "said once");
    }

    #[test]
    fn retries_opening_on_each_device_check_until_it_works() {
        let shared = Shared::default();
        let mut backend: Slot = None;
        let tries = Mutex::new(0);
        let open = || {
            *tries.lock().unwrap() += 1;
            None
        };
        shared.poll(&mut backend, open, 1, None);
        shared.poll(&mut backend, open, DEVICE_CHECK_EVERY, None);
        shared.poll(&mut backend, open, DEVICE_CHECK_EVERY * 2, None);
        assert_eq!(*tries.lock().unwrap(), 2, "only on device checks, not every 100 ms");
    }
}
