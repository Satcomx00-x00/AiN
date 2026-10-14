//! Now playing: whatever the OS media controls report (Spotify, browsers, players), with controls.

#[cfg(windows)]
mod windows;

use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State,
    plugin::{Builder, TauriPlugin},
};

use super::{live::Live, worker::Worker};
use crate::Res;

pub const EVENT: &str = "media:state";
#[cfg_attr(not(windows), allow(dead_code))]
const POLL: Duration = Duration::from_secs(1);
/// Spotify wins when several sessions are equally relevant.
const PREFERRED: &str = "Spotify";

#[derive(Debug, Clone, PartialEq, Serialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Control {
    Toggle,
    Next,
    Previous,
}

/// A player session, as far as choosing which one to show is concerned.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub app: String,
    pub playing: bool,
    /// The session the OS itself considers current.
    pub current: bool,
}

/// Prefers what is playing, then Spotify, then the OS's current session.
pub fn choose(candidates: &[Candidate]) -> Option<usize> {
    let rank = |c: &Candidate| (c.playing, c.app == PREFERRED, c.current);
    (0..candidates.len()).rev().max_by_key(|&i| rank(&candidates[i]))
}

/// "Spotify.exe" → "Spotify", "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" → "ZuneMusic",
/// "C:\…\vlc.exe" → "vlc".
pub fn app_name(id: &str) -> String {
    let id = id.split('!').next().unwrap_or(id);
    let id = id.rsplit(['\\', '/']).next().unwrap_or(id);
    let id = match id.len().checked_sub(4) {
        Some(cut) if id.is_char_boundary(cut) && id[cut..].eq_ignore_ascii_case(".exe") => &id[..cut],
        _ => id.split('_').next().unwrap_or(id).rsplit('.').next().unwrap_or(id),
    };
    id.to_string()
}

#[derive(Default)]
struct Shared {
    track: Live<Option<Track>>,
    artwork: Live<Option<String>>,
}

struct Media {
    shared: Arc<Shared>,
    worker: Worker<Control>,
}

#[tauri::command]
fn state(media: State<'_, Media>) -> Option<Track> {
    media.shared.track.get()
}

/// The current artwork as a `data:` URL.
#[tauri::command]
fn artwork(media: State<'_, Media>) -> Option<String> {
    media.shared.artwork.get()
}

#[tauri::command]
fn control(media: State<'_, Media>, action: Control) -> Res<()> {
    media.worker.send(action)
}

#[cfg(windows)]
fn spawn<R: Runtime>(app: AppHandle<R>, shared: Arc<Shared>) -> std::io::Result<Worker<Control>> {
    super::worker::spawn("media", POLL, windows::Source::new, move |source, command| {
        let Some(source) = source else { return };
        if let Some(c) = command {
            source.control(c);
        }
        let read = source.read();
        if let Some(art) = read.artwork {
            shared.artwork.set(art);
        }
        if shared.track.set(read.track.clone()) {
            let _ = app.emit(EVENT, read.track);
        }
    })
}

#[cfg(not(windows))]
fn spawn<R: Runtime>(_: AppHandle<R>, _: Arc<Shared>) -> std::io::Result<Worker<Control>> {
    Ok(Worker::unsupported())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("media")
        .invoke_handler(tauri::generate_handler![state, artwork, control])
        .setup(|app, _| {
            let shared = Arc::new(Shared::default());
            let worker = spawn(app.clone(), Arc::clone(&shared))?;
            app.manage(Media { shared, worker });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(app: &str, playing: bool, current: bool) -> Candidate {
        Candidate { app: app.into(), playing, current }
    }

    #[test]
    fn prefers_playing_over_current() {
        assert_eq!(choose(&[c("Chrome", false, true), c("vlc", true, false)]), Some(1));
    }

    #[test]
    fn prefers_spotify_among_playing() {
        assert_eq!(choose(&[c("Chrome", true, true), c("Spotify", true, false)]), Some(1));
    }

    #[test]
    fn falls_back_to_current_then_first() {
        assert_eq!(choose(&[c("A", false, false), c("B", false, true)]), Some(1));
        assert_eq!(choose(&[c("A", false, false), c("B", false, false)]), Some(0));
        assert_eq!(choose(&[]), None);
    }

    #[test]
    fn names_apps_from_their_ids() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "ZuneMusic");
        assert_eq!(app_name(r"C:\Program Files\VideoLAN\VLC\vlc.EXE"), "vlc");
        assert_eq!(app_name("Chrome"), "Chrome");
    }
}
