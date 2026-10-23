//! Read aloud: select text anywhere, press a shortcut, and it is read out loud. Speech is written on
//! this machine through sherpa-onnx (Kokoro, Kitten, Piper voices), by the model the user picks;
//! nothing leaves the computer. Each model is downloaded once, when the user asks.
//!
//! A worker thread owns the speakers. Each reading gets a thread that writes the speech a sentence
//! at a time, so it starts after the first sentence rather than once the whole text is written.
//! The selection comes from `selection.rs`.

mod engine;
mod model;
mod selection;

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Manager, State, Wry, plugin::TauriPlugin};
use tauri_specta::Event;

use super::{live::Live, worker::Worker};
use crate::{
    Res,
    shell::{
        popup::{self, ActionKind},
        settings::{self, SettingsChanged},
    },
};

pub use model::Status as ModelStatus;

const FEATURE: &str = "tts";
/// The command whose shortcut reads the selection.
const COMMAND: &str = "tts.read";
const TICK: Duration = Duration::from_millis(50);
/// A voice takes a few hundred MB of memory; it is let go after this long unused.
const KEEP_WARM: Duration = Duration::from_secs(10 * 60);

/// The chosen model's status, the folder it is (or would be) stored in, and which models are downloaded.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct ModelInfo {
    model: &'static str,
    dir: String,
    installed: Vec<&'static str>,
    #[serde(flatten)]
    status: ModelStatus,
}

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

/// Which model the settings pick, and the models folder it goes in.
#[derive(Clone, PartialEq)]
struct Place {
    base: PathBuf,
    model: &'static str,
}

impl Place {
    fn read(settings: &Value, default: &Path) -> Self {
        let option = |key: &str| settings::option(settings, FEATURE, key).and_then(Value::as_str);
        Self { base: model::base_in(option("modelDir"), default), model: model::find(option("model")).id }
    }

    fn model(&self) -> &'static model::Model {
        model::find(Some(self.model))
    }

    fn dir(&self) -> PathBuf {
        self.base.join(self.model().folder)
    }
}

/// Shared between the commands, the worker and the writer threads.
struct Shared {
    phase: Live<Phase>,
    model: Live<ModelInfo>,
    /// Follows the "Voice model" and "Model folder" settings.
    place: Mutex<Place>,
    /// The app's own data folder, used when no folder is chosen.
    default_dir: PathBuf,
    /// Loaded on first use, kept warm, dropped after `KEEP_WARM`.
    voice: Mutex<Option<Arc<sherpa_onnx::OfflineTts>>>,
    last_used: Mutex<Instant>,
    /// Bumped by every reading and stop, so a stale writer stops writing.
    session: AtomicU64,
    stop_download: AtomicBool,
    downloading: AtomicBool,
}

impl Shared {
    fn publish(&self, app: &AppHandle, phase: Phase) {
        if self.phase.set(phase.clone()) {
            let _ = PhaseChanged(phase).emit(app);
        }
    }

    fn place(&self) -> Place {
        lock(&self.place).clone()
    }

    fn info(place: &Place, status: ModelStatus) -> ModelInfo {
        ModelInfo {
            model: place.model().id,
            dir: place.dir().to_string_lossy().into_owned(),
            installed: model::installed_in(&place.base),
            status,
        }
    }

    fn publish_model(&self, app: &AppHandle, status: ModelStatus) {
        let info = Self::info(&self.place(), status);
        if self.model.set(info.clone()) {
            let _ = ModelChanged(info).emit(app);
        }
    }

    /// Re-reads the "Voice model" and "Model folder" settings; when they changed, that model is used
    /// from then on. A download in progress finishes first, then the new choice applies.
    fn follow_settings(&self, app: &AppHandle, settings: &Value) {
        let place = Place::read(settings, &self.default_dir);
        if *lock(&self.place) == place || self.downloading.load(Ordering::SeqCst) {
            return;
        }
        *lock(&self.place) = place.clone();
        lock(&self.voice).take();
        self.publish_model(app, place.model().status(&place.dir()));
    }
}

struct Tts {
    shared: Arc<Shared>,
    worker: Worker<Request>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
#[specta::specta]
fn state(tts: State<'_, Tts>) -> Phase {
    tts.shared.phase.get()
}

#[tauri::command]
#[specta::specta]
fn model_status(tts: State<'_, Tts>) -> ModelInfo {
    tts.shared.model.get()
}

/// Shows the model's folder (or the nearest one that exists) in the file manager.
#[tauri::command]
#[specta::specta]
async fn open_model_dir(tts: State<'_, Tts>) -> Res<()> {
    let dir = tts.shared.place().dir();
    let existing = dir.ancestors().find(|p| p.is_dir()).map(Path::to_path_buf).unwrap_or(dir);
    crate::platform::reveal(&existing)?;
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
    let shared = Arc::clone(&tts.shared);
    if shared.downloading.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    shared.stop_download.store(false, Ordering::SeqCst);
    let spawned = std::thread::Builder::new().name("tts-download".into()).spawn({
        let shared = Arc::clone(&shared);
        move || {
            let place = shared.place();
            let (model, dir) = (place.model(), place.dir());
            shared.publish_model(&app, ModelStatus::Downloading { received: 0, total: model.size });
            let result = model::download(model, &place.base, &shared.stop_download, |received, total| {
                shared.publish_model(&app, ModelStatus::Downloading { received, total });
            });
            let status = match result {
                Ok(()) => ModelStatus::Ready,
                Err(model::DownloadError::Cancelled) => model.status(&dir),
                Err(e) => ModelStatus::Error { message: e.to_string() },
            };
            shared.publish_model(&app, status);
            shared.downloading.store(false, Ordering::SeqCst);
            // The user may have picked another model meanwhile.
            shared.follow_settings(&app, &settings::current(&app));
        }
    });
    if let Err(e) = spawned {
        shared.downloading.store(false, Ordering::SeqCst);
        return Err(e.into());
    }
    Ok(())
}

/// Stops a download in progress, or deletes the downloaded model.
#[tauri::command]
#[specta::specta]
fn delete_model(app: AppHandle, tts: State<'_, Tts>) -> Res<()> {
    let shared = &tts.shared;
    if shared.downloading.load(Ordering::SeqCst) {
        shared.stop_download.store(true, Ordering::SeqCst);
        return Ok(());
    }
    lock(&shared.voice).take();
    let place = shared.place();
    model::remove(&place.dir())?;
    shared.publish_model(&app, place.model().status(&place.dir()));
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
    super::worker::spawn("tts", TICK, engine::Speaker::default, move |speaker, request| speaker.step(&app, &shared, request))
}

crate::ipc::tts!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let default_dir = app.path().app_data_dir()?.join("models");
        let place = Place::read(&settings::current(app), &default_dir);
        let info = Shared::info(&place, place.model().status(&place.dir()));
        let shared = Arc::new(Shared {
            phase: Live::new(Phase::Idle),
            model: Live::new(info),
            place: Mutex::new(place),
            default_dir,
            voice: Mutex::new(None),
            last_used: Mutex::new(Instant::now()),
            session: AtomicU64::new(0),
            stop_download: AtomicBool::new(false),
            downloading: AtomicBool::new(false),
        });
        let worker = spawn(app.clone(), Arc::clone(&shared))?;
        let (handle, followed) = (app.clone(), Arc::clone(&shared));
        SettingsChanged::listen_any(app, move |event| followed.follow_settings(&handle, &event.payload.0.0));
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
    fn reads_the_chosen_model_and_folder() {
        let default = std::env::temp_dir().join("island-default");
        let chosen = std::env::temp_dir().join("island-chosen");
        let settings = serde_json::json!({ "options": { "tts": { "model": "piper-de-thorsten", "modelDir": chosen.to_str() } } });
        assert_eq!(Place::read(&settings, &default).dir(), chosen.join("vits-piper-de_DE-thorsten-medium"));
        assert_eq!(Place::read(&serde_json::json!({}), &default).dir(), default.join("kokoro-en-v0_19"));
    }

    #[test]
    fn phases_serialize_for_the_page() {
        let speaking = serde_json::to_value(Phase::Speaking { text: "Hi".into() }).unwrap();
        assert_eq!(speaking, serde_json::json!({ "phase": "speaking", "text": "Hi" }));
        assert_eq!(serde_json::to_value(Phase::NothingSelected).unwrap(), serde_json::json!({ "phase": "nothingSelected" }));
    }

    #[test]
    fn model_info_flattens_the_status() {
        let info = ModelInfo { model: "kitten-nano", dir: "D:\\Voices".into(), installed: vec![], status: ModelStatus::Ready };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({ "model": "kitten-nano", "dir": "D:\\Voices", "installed": [], "state": "ready" })
        );
    }
}
