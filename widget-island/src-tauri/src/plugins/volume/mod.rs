//! Volume: the default output (for the pop-up on volume keys), plus a mixer of every source —
//! active output devices and the apps playing on them — each with its level and mute.

// Only Windows has a backend; elsewhere the commands report `Unsupported` and the rest goes unused.
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

#[cfg(windows)]
mod windows;

use std::{sync::Arc, time::Duration};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State,
    plugin::{Builder, TauriPlugin},
};

use super::{live::Live, worker::Worker};
use crate::Res;

pub const EVENT: &str = "volume:state";
pub const SOURCES_EVENT: &str = "volume:sources";
/// Fast enough that the collapsed pill reacts to volume keys right away.
const POLL: Duration = Duration::from_millis(100);
/// Polls between checks for a new default output device (~2 s).
const DEVICE_CHECK_EVERY: u32 = 20;
/// Polls between mixer refreshes (~1 s); enumerating every session is heavier than one volume read.
const SOURCES_EVERY: u32 = 10;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Output {
    /// 0–1, rounded to whole percent so tiny float noise doesn't count as a change.
    pub level: f32,
    pub muted: bool,
    pub device: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Device,
    App,
}

/// Something with its own volume: an output device, or an app (all its audio sessions together).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Source {
    /// "device:<endpoint id>" or "app:<exe name, lowercase>".
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

pub fn round_level(level: f32) -> f32 {
    (level.clamp(0.0, 1.0) * 100.0).round() / 100.0
}

/// "Spotify.exe" → id "app:spotify", label "Spotify".
pub fn app_identity(exe: &str) -> (String, String) {
    let stem = exe.rsplit(['\\', '/']).next().unwrap_or(exe);
    let stem = match stem.len().checked_sub(4) {
        Some(cut) if stem.is_char_boundary(cut) && stem[cut..].eq_ignore_ascii_case(".exe") => &stem[..cut],
        _ => stem,
    };
    let mut label = stem.to_string();
    if let Some(first) = label.get(..1) {
        label.replace_range(..1, &first.to_uppercase());
    }
    (format!("app:{}", stem.to_lowercase()), label)
}

/// Devices first (the default one leading), then apps — those playing first — each alphabetically.
pub fn sort(sources: &mut [Source]) {
    sources.sort_by(|a, b| {
        let rank = |s: &Source| (s.kind == SourceKind::App, !s.default, !s.active);
        rank(a).cmp(&rank(b)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

#[derive(Default)]
struct Shared {
    output: Live<Option<Output>>,
    peak: Live<f32>,
    sources: Live<Vec<Source>>,
}

struct Volume {
    shared: Arc<Shared>,
    worker: Worker<Command>,
}

#[tauri::command]
fn state(volume: State<'_, Volume>) -> Option<Output> {
    volume.shared.output.get()
}

/// Current loudness of the default output, 0–1.
#[tauri::command]
fn peak(volume: State<'_, Volume>) -> f32 {
    volume.shared.peak.get()
}

/// Every source that can be mixed.
#[tauri::command]
fn sources(volume: State<'_, Volume>) -> Vec<Source> {
    volume.shared.sources.get()
}

#[tauri::command]
fn set_level(volume: State<'_, Volume>, source: Option<String>, level: f32) -> Res<()> {
    volume.worker.send(Command { source, change: Change::Level(level.clamp(0.0, 1.0)) })
}

#[tauri::command]
fn set_muted(volume: State<'_, Volume>, source: Option<String>, muted: bool) -> Res<()> {
    volume.worker.send(Command { source, change: Change::Muted(muted) })
}

#[cfg(windows)]
fn spawn<R: Runtime>(app: AppHandle<R>, shared: Arc<Shared>) -> std::io::Result<Worker<Command>> {
    let mut polls = 0u32;
    super::worker::spawn("volume", POLL, windows::Endpoint::new, move |endpoint, command: Option<Command>| {
        polls = polls.wrapping_add(1);
        if polls.is_multiple_of(DEVICE_CHECK_EVERY) {
            windows::Endpoint::follow_default(endpoint);
        }
        let Some(ep) = endpoint else { return };
        let changed = command.is_some();
        if let Some(Command { source, change }) = command {
            match source {
                Some(id) => ep.apply_to(&id, change),
                None => ep.apply(change),
            }
        }
        let (output, peak) = ep.read().map_or((None, 0.0), |(o, p)| (Some(o), p));
        shared.peak.set(peak);
        if shared.output.set(output.clone()) {
            let _ = app.emit(EVENT, output);
        }
        if changed || polls.is_multiple_of(SOURCES_EVERY) {
            let sources = ep.sources();
            if shared.sources.set(sources.clone()) {
                let _ = app.emit(SOURCES_EVENT, sources);
            }
        }
    })
}

#[cfg(not(windows))]
fn spawn<R: Runtime>(_: AppHandle<R>, _: Arc<Shared>) -> std::io::Result<Worker<Command>> {
    Ok(Worker::unsupported())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("volume")
        .invoke_handler(tauri::generate_handler![state, peak, sources, set_level, set_muted])
        .setup(|app, _| {
            let shared = Arc::new(Shared::default());
            let worker = spawn(app.clone(), Arc::clone(&shared))?;
            app.manage(Volume { shared, worker });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_and_clamps_levels() {
        assert_eq!(round_level(0.456_78), 0.46);
        assert_eq!(round_level(1.2), 1.0);
        assert_eq!(round_level(-0.1), 0.0);
    }

    #[test]
    fn names_apps_from_their_executables() {
        assert_eq!(app_identity("Spotify.exe"), ("app:spotify".into(), "Spotify".into()));
        assert_eq!(app_identity(r"C:\Program Files\Discord\discord.EXE"), ("app:discord".into(), "Discord".into()));
    }

    fn s(id: &str, kind: SourceKind, default: bool, active: bool) -> Source {
        Source { id: id.into(), kind, name: id.into(), level: 1.0, muted: false, default, active }
    }

    #[test]
    fn sorts_default_device_first_then_devices_then_playing_apps() {
        let mut list = vec![
            s("zoom", SourceKind::App, false, false),
            s("spotify", SourceKind::App, false, true),
            s("chat", SourceKind::Device, false, true),
            s("gaming", SourceKind::Device, true, true),
        ];
        sort(&mut list);
        let order: Vec<&str> = list.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(order, ["gaming", "chat", "spotify", "zoom"]);
    }
}
