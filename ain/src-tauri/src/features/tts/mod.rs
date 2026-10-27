//! Read aloud: select text anywhere, press a shortcut, and it is read out loud. Speech is written on
//! this machine through sherpa-onnx (Kokoro, Kitten, Piper voices), by the model the user picks;
//! nothing leaves the computer. Each model is downloaded once, when the user asks. Or, when the user
//! picks one of their AI providers instead (`shell::providers`), its text-to-speech model reads.
//!
//! A worker thread owns the speakers. Each reading gets a thread that writes the speech a sentence
//! at a time, so it starts after the first sentence rather than once the whole text is written.
//! The selection comes from `features/selection.rs`, the model and its download from `features/models.rs`.

mod engine;
mod model;

use std::{
    sync::{Arc, atomic::AtomicU64},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State, Wry, plugin::TauriPlugin};
use tauri_specta::Event;

use super::{
    live::Live,
    lock,
    models::{ModelInfo, ModelStore},
    worker::Worker,
};
use crate::{
    Res,
    shell::{
        popup::{self, ActionKind},
        settings::{self, SettingsChanged},
    },
};

const FEATURE: &str = "tts";
/// The command whose shortcut reads the selection.
const COMMAND: &str = "tts.read";
const TICK: Duration = Duration::from_millis(50);
/// A voice takes a few hundred MB of memory; it is let go after this long unused.
const KEEP_WARM: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    /// The shortcut fired but the model isn't downloaded.
    NeedsModel,
    /// The shortcut fired but no text is selected (or it couldn't be read).
    NothingSelected,
    /// Loading the voice and writing the first sentence.
    Preparing,
    Speaking {
        text: String,
    },
    Error {
        message: String,
    },
}

/// The reading's phase, sent on every change.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct PhaseChanged(pub Phase);

/// The voice model's status, sent as it changes (and as it downloads).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct ModelChanged(pub ModelInfo);

/// `toggle` reads the selection, or stops reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Command {
    Toggle,
    Stop,
}

/// What the speaker worker is asked.
enum Request {
    Toggle,
    Stop,
    Say(String),
}

impl From<Command> for Request {
    fn from(command: Command) -> Self {
        match command {
            Command::Toggle => Self::Toggle,
            Command::Stop => Self::Stop,
        }
    }
}

/// Shared between the commands, the worker and the writer threads.
struct Shared {
    phase: Live<Phase>,
    /// The chosen voice model, its download, and the loaded voice.
    models: Arc<ModelStore<model::Model, sherpa_onnx::OfflineTts>>,
    /// Bumped by every reading and stop, so a stale writer stops writing.
    session: AtomicU64,
}

impl Shared {
    fn publish(&self, app: &AppHandle, phase: Phase) {
        if self.phase.set(phase.clone()) {
            let _ = PhaseChanged(phase).emit(app);
        }
    }
}

struct Tts {
    shared: Arc<Shared>,
    worker: Worker<Request>,
}

#[tauri::command]
#[specta::specta]
fn state(tts: State<'_, Tts>) -> Phase {
    tts.shared.phase.get()
}

#[tauri::command]
#[specta::specta]
fn model_status(tts: State<'_, Tts>) -> ModelInfo {
    tts.shared.models.info()
}

/// Shows the model's folder (or the nearest one that exists) in the file manager.
#[tauri::command]
#[specta::specta]
async fn open_model_dir(tts: State<'_, Tts>) -> Res<()> {
    crate::platform::reveal(&tts.shared.models.existing_dir())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn control(tts: State<'_, Tts>, command: Command) -> Res<()> {
    tts.worker.send(command.into())
}

/// Reads `text` out loud, instead of the selection: to read something again, or to try a voice.
#[tauri::command]
#[specta::specta]
fn speak(tts: State<'_, Tts>, text: String) -> Res<()> {
    tts.worker.send(Request::Say(text))
}

/// Starts downloading the model in the background; progress arrives as `ModelChanged` events.
#[tauri::command]
#[specta::specta]
fn download_model(app: AppHandle, tts: State<'_, Tts>) -> Res<()> {
    tts.shared.models.download(app)?;
    Ok(())
}

/// Stops a download in progress, or deletes the downloaded model.
#[tauri::command]
#[specta::specta]
fn delete_model(app: AppHandle, tts: State<'_, Tts>) -> Res<()> {
    tts.shared.models.remove(&app)?;
    Ok(())
}

/// What a shortcut event means for reading: each press reads the selection, or stops.
pub fn command_for(kind: ActionKind) -> Option<Command> {
    match kind {
        ActionKind::Press | ActionKind::Tap => Some(Command::Toggle),
        ActionKind::Release => None,
    }
}

fn on_shortcut(app: &AppHandle, action: &popup::Action) {
    if action.command != COMMAND {
        return;
    }
    if let Some(command) = command_for(action.kind)
        && let Err(e) = app.state::<Tts>().worker.send(command.into())
    {
        eprintln!("island: tts: {e}");
    }
}

fn spawn(app: AppHandle, shared: Arc<Shared>) -> std::io::Result<Worker<Request>> {
    super::worker::spawn(
        "tts",
        TICK,
        || engine::Speaker::new(super::selection::selected),
        move |speaker, request| speaker.step(&app, &shared, request),
    )
}

crate::ipc::tts!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let default_dir = app.path().app_data_dir()?.join("models");
        let emit = |app: &AppHandle, info| drop(ModelChanged(info).emit(app));
        let models = Arc::new(ModelStore::new(FEATURE, model::MODELS, &settings::current(app), default_dir, emit, engine::load));
        models.preload();
        let shared = Arc::new(Shared { phase: Live::new(Phase::Idle), models, session: AtomicU64::new(0) });
        let worker = spawn(app.clone(), Arc::clone(&shared))?;
        let (handle, followed) = (app.clone(), Arc::clone(&shared));
        SettingsChanged::listen_any(app, move |event| followed.models.follow_settings(&handle, &event.payload.0.0));
        app.manage(Tts { shared, worker });
        let handle = app.clone();
        popup::Action::listen_any(app, move |event| on_shortcut(&handle, &event.payload));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_press_reads_or_stops() {
        assert_eq!(command_for(ActionKind::Press), Some(Command::Toggle));
        assert_eq!(command_for(ActionKind::Tap), Some(Command::Toggle));
        assert_eq!(command_for(ActionKind::Release), None);
    }

    #[test]
    fn defaults_to_the_first_voice_model() {
        let store = ModelStore::<_, ()>::new(FEATURE, model::MODELS, &serde_json::json!({}), "models".into(), |_, _| {}, |_, _| Ok(()));
        assert!(store.chosen().1.ends_with("kokoro-en-v0_19"));
    }

    #[test]
    fn phases_serialize_for_the_page() {
        let speaking = serde_json::to_value(Phase::Speaking { text: "Hi".into() }).unwrap();
        assert_eq!(speaking, serde_json::json!({ "phase": "speaking", "text": "Hi" }));
        assert_eq!(serde_json::to_value(Phase::NothingSelected).unwrap(), serde_json::json!({ "phase": "nothingSelected" }));
    }
}
