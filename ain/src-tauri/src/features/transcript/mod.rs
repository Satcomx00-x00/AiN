//! Transcript: what the computer plays (a video, a call, a chat app) written down as it is heard.
//! The system's sound is recorded in loopback (`loopback.rs`: WASAPI on Windows, a Core Audio tap
//! on macOS 14.6+, the default sink's monitor on Linux) and recognized by dictation's speech model,
//! on this machine, or by the AI provider the user picks (`shell::providers`).
//!
//! A worker thread owns the recording. It cuts the audio in short chunks, at pauses, so lines show up
//! a few seconds after they are said; a decoder thread recognizes each chunk and adds its line.
//! Silent chunks are skipped, so nothing is sent (or decoded) while nothing plays.

mod engine;
#[cfg(target_os = "linux")]
mod linux;
mod loopback;
mod text;

use std::{
    sync::{Arc, atomic::AtomicU64},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State, Wry, plugin::TauriPlugin};
use tauri_specta::Event;

use super::{live::Live, worker::Worker};
use crate::{
    Res,
    shell::popup::{self, ActionKind},
};

pub use text::Line;

const FEATURE: &str = "transcript";
/// The command whose shortcut starts and stops listening.
const COMMAND: &str = "transcript.toggle";
const TICK: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    /// Asked to listen on this computer, but dictation's speech model isn't downloaded.
    NeedsModel,
    Listening {
        level: f32,
        seconds: f32,
    },
    /// Stopped; the last chunk is being recognized.
    Finishing,
    Error {
        message: String,
    },
}

/// The phase, sent on every change (the level updates ~20×/s while listening).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct PhaseChanged(pub Phase);

/// The whole transcript, sent as each line is added and when it is cleared.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct LinesChanged(pub Vec<Line>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Command {
    Start,
    Stop,
    Toggle,
    /// Forgets the lines heard so far.
    Clear,
}

/// Shared between the commands, the worker and the decoder threads.
struct Shared {
    phase: Live<Phase>,
    lines: Live<Vec<Line>>,
    /// Bumped by every start, so a stale decoder's lines are thrown away.
    session: AtomicU64,
}

impl Shared {
    fn publish(&self, app: &AppHandle, phase: Phase) {
        if self.phase.set(phase.clone()) {
            let _ = PhaseChanged(phase).emit(app);
        }
    }

    fn update_lines(&self, app: &AppHandle, edit: impl FnOnce(&mut Vec<Line>)) {
        let mut lines = self.lines.get();
        edit(&mut lines);
        if self.lines.set(lines.clone()) {
            let _ = LinesChanged(lines).emit(app);
        }
    }
}

struct Transcript {
    shared: Arc<Shared>,
    worker: Worker<Command>,
}

#[tauri::command]
#[specta::specta]
fn state(transcript: State<'_, Transcript>) -> Phase {
    transcript.shared.phase.get()
}

#[tauri::command]
#[specta::specta]
fn lines(transcript: State<'_, Transcript>) -> Vec<Line> {
    transcript.shared.lines.get()
}

#[tauri::command]
#[specta::specta]
fn control(transcript: State<'_, Transcript>, command: Command) -> Res<()> {
    transcript.worker.send(command)
}

/// Each press of the shortcut starts or stops listening.
fn on_shortcut(app: &AppHandle, action: &popup::Action) {
    if action.command != COMMAND || action.kind == ActionKind::Release {
        return;
    }
    if let Err(e) = app.state::<Transcript>().worker.send(Command::Toggle) {
        eprintln!("island: transcript: {e}");
    }
}

crate::ipc::transcript!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let shared = Arc::new(Shared { phase: Live::new(Phase::Idle), lines: Live::new(Vec::new()), session: AtomicU64::new(0) });
        let (handle, owned) = (app.clone(), Arc::clone(&shared));
        let worker = super::worker::spawn("transcript", TICK, engine::Listener::default, move |listener, command| {
            listener.step(&handle, &owned, command)
        })?;
        app.manage(Transcript { shared, worker });
        let handle = app.clone();
        popup::Action::listen_any(app, move |event| on_shortcut(&handle, &event.payload));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_serialize_for_the_page() {
        let json = serde_json::to_value(Phase::Listening { level: 0.5, seconds: 2.0 }).unwrap();
        assert_eq!(json, serde_json::json!({ "phase": "listening", "level": 0.5, "seconds": 2.0 }));
        assert_eq!(serde_json::to_value(Phase::NeedsModel).unwrap(), serde_json::json!({ "phase": "needsModel" }));
        assert_eq!(serde_json::to_value(Phase::Finishing).unwrap(), serde_json::json!({ "phase": "finishing" }));
    }

    #[test]
    fn commands_read_from_the_page() {
        assert_eq!(serde_json::from_value::<Command>(serde_json::json!("clear")).unwrap(), Command::Clear);
    }
}
