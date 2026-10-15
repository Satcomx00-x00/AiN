//! Now playing: whatever the OS media controls report (Spotify, browsers, players), with controls.
//! Windows reads its media transport controls (`windows.rs`), Linux the MPRIS players on D-Bus
//! (`linux.rs`).

#[cfg(any(windows, target_os = "linux"))]
mod choose;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State, Wry, plugin::TauriPlugin};
use tauri_specta::Event;

use super::{live::Live, worker::Worker};
use crate::{Error, Res};

const POLL: Duration = Duration::from_secs(1);
/// Whether this platform has a backend at all; without one, controls say so instead of doing nothing.
const SUPPORTED: bool = cfg!(any(windows, target_os = "linux"));

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Friendly name of the player, e.g. "Spotify".
    pub app: String,
    pub playing: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
    /// Unix ms at which `position_ms` was measured, so the UI can extrapolate while playing.
    pub measured_at: u64,
    /// Changes whenever the artwork does; fetch the image itself with `artwork`.
    pub artwork_key: String,
}

/// The track now (none when nothing plays), sent whenever it changes.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TrackChanged(pub Option<Track>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Control {
    Toggle,
    Next,
    Previous,
}

/// One look at the player.
pub struct Read {
    pub track: Option<Track>,
    /// `Some` only when the artwork changed: the new image as a `data:` URL, or `None` if there is none.
    pub artwork: Option<Option<String>>,
}

/// A platform's media session API, owned by the worker thread.
pub trait Backend {
    fn read(&mut self) -> Read;
    fn control(&mut self, control: Control);
}

/// The worker's backend, when it has one.
type Slot = Option<Box<dyn Backend>>;

/// This platform's backend, or `None` where there is none (or it isn't available right now).
fn open() -> Slot {
    #[cfg(windows)]
    return windows::Source::new().map(|s| Box::new(s) as Box<dyn Backend>);
    #[cfg(target_os = "linux")]
    return linux::Players::new().map(|p| Box::new(p) as Box<dyn Backend>);
    #[cfg(not(any(windows, target_os = "linux")))]
    None
}

/// Polls between attempts to open the backend when it isn't available (~10 s).
const RETRY_EVERY: u32 = 10;

#[derive(Default)]
struct Shared {
    track: Live<Option<Track>>,
    artwork: Live<Option<String>>,
}

impl Shared {
    /// One worker tick (`polls` counts them): opens the backend if it couldn't be yet, runs
    /// `command`, then reads. Returns the track when it changed.
    fn poll(&self, backend: &mut Slot, open: impl Fn() -> Slot, polls: u32, command: Option<Control>) -> Option<Option<Track>> {
        if backend.is_none() && polls.is_multiple_of(RETRY_EVERY) {
            *backend = open();
        }
        let b = backend.as_mut()?;
        if let Some(c) = command {
            b.control(c);
        }
        let read = b.read();
        if let Some(art) = read.artwork {
            self.artwork.set(art);
        }
        self.track.set(read.track.clone()).then_some(read.track)
    }
}

struct Media {
    shared: Arc<Shared>,
    worker: Worker<Control>,
}

#[tauri::command]
#[specta::specta]
fn state(media: State<'_, Media>) -> Option<Track> {
    media.shared.track.get()
}

/// The current artwork as a `data:` URL.
#[tauri::command]
#[specta::specta]
fn artwork(media: State<'_, Media>) -> Option<String> {
    media.shared.artwork.get()
}

#[tauri::command]
#[specta::specta]
fn control(media: State<'_, Media>, action: Control) -> Res<()> {
    if !SUPPORTED {
        return Err(Error::Unsupported);
    }
    media.worker.send(action)
}

fn spawn(app: AppHandle, shared: Arc<Shared>) -> std::io::Result<Worker<Control>> {
    let mut polls = 0u32;
    super::worker::spawn("media", POLL, open, move |backend, command| {
        polls = polls.wrapping_add(1);
        if let Some(track) = shared.poll(backend, open, polls, command) {
            let _ = TrackChanged(track).emit(&app);
        }
    })
}

crate::ipc::media!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let shared = Arc::new(Shared::default());
        let worker = spawn(app.clone(), Arc::clone(&shared))?;
        app.manage(Media { shared, worker });
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Mutex};

    use super::*;

    /// A backend that plays back scripted reads and records controls.
    struct Fake {
        reads: VecDeque<Read>,
        controls: Arc<Mutex<Vec<Control>>>,
    }

    impl Backend for Fake {
        fn read(&mut self) -> Read {
            self.reads.pop_front().unwrap_or(Read { track: None, artwork: None })
        }
        fn control(&mut self, control: Control) {
            self.controls.lock().unwrap().push(control);
        }
    }

    fn track(title: &str) -> Track {
        Track {
            title: title.into(),
            artist: "A".into(),
            album: String::new(),
            app: "Spotify".into(),
            playing: true,
            position_ms: 0,
            duration_ms: 1,
            measured_at: 0,
            artwork_key: title.into(),
        }
    }

    fn fake(reads: Vec<Read>) -> (Slot, Arc<Mutex<Vec<Control>>>) {
        let controls = Arc::new(Mutex::new(Vec::new()));
        (Some(Box::new(Fake { reads: reads.into(), controls: Arc::clone(&controls) })), controls)
    }

    const NEVER: fn() -> Slot = || panic!("opened while a backend exists");

    #[test]
    fn controls_first_then_announces_a_new_track_once() {
        let shared = Shared::default();
        let same = || Read { track: Some(track("Song")), artwork: None };
        let (mut backend, controls) = fake(vec![same(), same()]);
        assert_eq!(shared.poll(&mut backend, NEVER, 1, Some(Control::Next)), Some(Some(track("Song"))));
        assert_eq!(*controls.lock().unwrap(), [Control::Next]);
        assert_eq!(shared.poll(&mut backend, NEVER, 2, None), None, "same track: nothing to announce");
    }

    #[test]
    fn keeps_the_artwork_until_the_backend_says_it_changed() {
        let shared = Shared::default();
        let (mut backend, _) = fake(vec![
            Read { track: Some(track("A")), artwork: Some(Some("data:a".into())) },
            Read { track: Some(track("A")), artwork: None },
            Read { track: None, artwork: Some(None) },
        ]);
        shared.poll(&mut backend, NEVER, 1, None);
        shared.poll(&mut backend, NEVER, 2, None);
        assert_eq!(shared.artwork.get().as_deref(), Some("data:a"));
        assert_eq!(shared.poll(&mut backend, NEVER, 3, None), Some(None), "playback stopped");
        assert_eq!(shared.artwork.get(), None);
    }

    #[test]
    fn retries_opening_now_and_then_until_the_system_is_ready() {
        let shared = Shared::default();
        let mut backend: Slot = None;
        let tries = Mutex::new(0);
        let ready = Mutex::new(fake(vec![Read { track: Some(track("Late")), artwork: None }]).0);
        let open = || {
            *tries.lock().unwrap() += 1;
            ready.lock().unwrap().take()
        };
        for polls in 1..RETRY_EVERY {
            assert_eq!(shared.poll(&mut backend, open, polls, None), None);
        }
        assert_eq!(*tries.lock().unwrap(), 0, "not on every poll");
        assert_eq!(shared.poll(&mut backend, open, RETRY_EVERY, None), Some(Some(track("Late"))));
        assert_eq!(*tries.lock().unwrap(), 1);
    }
}
