//! Dictation: hold or tap a shortcut, speak, and the words land where the cursor is.
//! Speech is recognized on this machine through sherpa-onnx (as Orca does), by the model the user
//! picks (Parakeet, Whisper, SenseVoice, Moonshine); nothing leaves the computer. Each model is
//! downloaded once, when the user asks.
//!
//! A worker thread owns the microphone stream. While listening it feeds 16 kHz audio to a
//! decoder thread in 30 s chunks, so long dictations are mostly transcribed by the time they end.
//! The text is then typed at the cursor (`windows.rs`; on macOS and Linux, the platform's key
//! helpers), or put on the clipboard when the system won't let us type: macOS until the user allows
//! Accessibility access, Wayland without `wtype` or `ydotool`, X11 without `xdotool`.

mod chunk;
mod engine;
mod model;
#[cfg(windows)]
mod windows;

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

const FEATURE: &str = "dictation";
/// The command whose shortcut drives dictation.
const COMMAND: &str = "dictation.toggle";
const TICK: Duration = Duration::from_millis(50);
/// A forgotten dictation stops by itself.
const MAX_SECONDS: f32 = 300.0;
/// The model takes about 1 GB of memory; it is let go after this long unused.
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

/// A microphone dictation can listen to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Microphone {
    /// Stable across runs and reboots: what the "microphone" option stores.
    pub id: String,
    pub name: String,
}

/// The microphone the settings pick, or `None` for the system's default one.
pub fn chosen_microphone(settings: &Value) -> Option<String> {
    settings::option(settings, FEATURE, "microphone").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string)
}

/// How the text reached the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    /// Typed at the cursor.
    Typed,
    /// Put on the clipboard, to paste.
    Copied,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    /// The shortcut fired but the model isn't downloaded.
    NeedsModel,
    Listening {
        level: f32,
        seconds: f32,
    },
    Transcribing,
    Done {
        text: String,
        /// How the text was handed over; none when nothing was heard.
        delivery: Option<Delivery>,
    },
    Error {
        message: String,
    },
}

/// The dictation's phase, sent on every change (the level updates ~20×/s while listening).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct PhaseChanged(pub Phase);

/// The speech model's status, sent as it changes (and as it downloads).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct ModelChanged(pub ModelInfo);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Command {
    Start,
    Stop,
    Toggle,
    Cancel,
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

/// Shared between the commands, the worker and the decoder threads.
struct Shared {
    phase: Live<Phase>,
    model: Live<ModelInfo>,
    /// Follows the "Speech model" and "Model folder" settings.
    place: Mutex<Place>,
    /// The app's own data folder, used when no folder is chosen.
    default_dir: PathBuf,
    /// Loaded on first use, kept warm, dropped after `KEEP_WARM`.
    recognizer: Mutex<Option<Arc<sherpa_onnx::OfflineRecognizer>>>,
    last_used: Mutex<Instant>,
    /// Bumped by every start and cancel, so a stale decoder's result is thrown away.
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

    /// Re-reads the "Speech model" and "Model folder" settings; when they changed, that model is used
    /// from then on. A download in progress finishes first, then the new choice applies.
    fn follow_settings(&self, app: &AppHandle, settings: &Value) {
        let place = Place::read(settings, &self.default_dir);
        if *lock(&self.place) == place || self.downloading.load(Ordering::SeqCst) {
            return;
        }
        *lock(&self.place) = place.clone();
        lock(&self.recognizer).take();
        self.publish_model(app, place.model().status(&place.dir()));
    }
}

struct Dictation {
    shared: Arc<Shared>,
    worker: Worker<Command>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Types `text` where the cursor is; false where the system doesn't let us.
fn type_text(text: &str) -> bool {
    #[cfg(windows)]
    {
        windows::type_text(text);
        true
    }
    #[cfg(target_os = "macos")]
    return crate::platform::macos::keys::type_text(text);
    #[cfg(target_os = "linux")]
    return crate::platform::linux::keys::type_text(text);
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = text;
        false
    }
}

/// Hands the recognized text over: typed at the cursor where the OS allows it, else copied, and
/// pasted where only a paste key can be pressed.
fn deliver(app: &AppHandle, text: &str) -> Delivery {
    if type_text(text) {
        return Delivery::Typed;
    }
    let copied = match app.try_state::<Arc<super::clipboard::Clipboard>>().map(|c| c.copy(text.to_string())) {
        Some(Ok(())) => true,
        Some(Err(e)) => {
            eprintln!("island: dictation: couldn't copy the text: {e}");
            false
        }
        None => false,
    };
    if copied && paste_copied() {
        return Delivery::Typed;
    }
    Delivery::Copied
}

/// Presses the paste key where typing isn't possible but that is (ydotool on GNOME).
fn paste_copied() -> bool {
    #[cfg(target_os = "linux")]
    {
        // Lets the compositor see the new clipboard before the target app asks for it.
        std::thread::sleep(Duration::from_millis(80));
        crate::platform::linux::keys::paste(None)
    }
    #[cfg(not(target_os = "linux"))]
    false
}

#[tauri::command]
#[specta::specta]
fn state(dictation: State<'_, Dictation>) -> Phase {
    dictation.shared.phase.get()
}

/// The microphones connected now. Async: listing devices can take a moment.
#[tauri::command]
#[specta::specta]
async fn microphones() -> Vec<Microphone> {
    engine::microphones()
}

#[tauri::command]
#[specta::specta]
fn model_status(dictation: State<'_, Dictation>) -> ModelInfo {
    dictation.shared.model.get()
}

/// Shows the model's folder (or the nearest one that exists) in the file manager.
#[tauri::command]
#[specta::specta]
async fn open_model_dir(dictation: State<'_, Dictation>) -> Res<()> {
    let dir = dictation.shared.place().dir();
    let existing = dir.ancestors().find(|p| p.is_dir()).map(Path::to_path_buf).unwrap_or(dir);
    crate::platform::reveal(&existing)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn control(dictation: State<'_, Dictation>, command: Command) -> Res<()> {
    dictation.worker.send(command)
}

/// Starts downloading the model in the background; progress arrives as `ModelChanged` events.
#[tauri::command]
#[specta::specta]
fn download_model(app: AppHandle, dictation: State<'_, Dictation>) -> Res<()> {
    let shared = Arc::clone(&dictation.shared);
    if shared.downloading.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    shared.stop_download.store(false, Ordering::SeqCst);
    let spawned = std::thread::Builder::new().name("dictation-download".into()).spawn({
        let shared = Arc::clone(&shared);
        move || {
            let place = shared.place();
            let (model, dir) = (place.model(), place.dir());
            shared.publish_model(&app, ModelStatus::Downloading { received: 0, total: model.total_size() });
            let result = model::download(model, &dir, &shared.stop_download, |received, total| {
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
fn delete_model(app: AppHandle, dictation: State<'_, Dictation>) -> Res<()> {
    let shared = &dictation.shared;
    if shared.downloading.load(Ordering::SeqCst) {
        shared.stop_download.store(true, Ordering::SeqCst);
        return Ok(());
    }
    lock(&shared.recognizer).take();
    let place = shared.place();
    model::remove(&place.dir())?;
    shared.publish_model(&app, place.model().status(&place.dir()));
    Ok(())
}

/// What a shortcut event means for dictation. "Hold to talk" listens while the keys are held;
/// otherwise each press toggles.
pub fn command_for(kind: ActionKind, hold: bool) -> Option<Command> {
    use ActionKind::*;
    match kind {
        Tap => Some(Command::Toggle),
        Press if hold => Some(Command::Start),
        Press => Some(Command::Toggle),
        Release if hold => Some(Command::Stop),
        Release => None,
    }
}

fn on_shortcut(app: &AppHandle, action: &popup::Action) {
    if action.command != COMMAND {
        return;
    }
    let hold = settings::option(&settings::current(app), FEATURE, "mode").and_then(Value::as_str) == Some("hold");
    if let Some(command) = command_for(action.kind, hold)
        && let Err(e) = app.state::<Dictation>().worker.send(command)
    {
        eprintln!("island: dictation: {e}");
    }
}

fn spawn(app: AppHandle, shared: Arc<Shared>) -> std::io::Result<Worker<Command>> {
    super::worker::spawn("dictation", TICK, engine::Mic::default, move |mic, command| mic.step(&app, &shared, command))
}

crate::ipc::dictation!();

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
            recognizer: Mutex::new(None),
            last_used: Mutex::new(Instant::now()),
            session: AtomicU64::new(0),
            stop_download: AtomicBool::new(false),
            downloading: AtomicBool::new(false),
        });
        let worker = spawn(app.clone(), Arc::clone(&shared))?;
        let (handle, followed) = (app.clone(), Arc::clone(&shared));
        SettingsChanged::listen_any(app, move |event| followed.follow_settings(&handle, &event.payload.0.0));
        app.manage(Dictation { shared, worker });
        let handle = app.clone();
        popup::Action::listen_any(app, move |event| on_shortcut(&handle, &event.payload));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ActionKind::*;

    #[test]
    fn hold_listens_while_held_and_toggle_on_each_press() {
        assert_eq!(command_for(Press, true), Some(Command::Start));
        assert_eq!(command_for(Release, true), Some(Command::Stop));
        assert_eq!(command_for(Press, false), Some(Command::Toggle));
        assert_eq!(command_for(Release, false), None);
        assert_eq!(command_for(Tap, true), Some(Command::Toggle));
    }

    #[test]
    fn model_info_flattens_the_status() {
        let info = ModelInfo {
            model: "whisper-small",
            dir: "D:\\Models".into(),
            installed: vec!["parakeet-v3"],
            status: ModelStatus::Downloading { received: 1, total: 2 },
        };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({ "model": "whisper-small", "dir": "D:\\Models", "installed": ["parakeet-v3"], "state": "downloading", "received": 1, "total": 2 })
        );
    }

    #[test]
    fn reads_the_chosen_model_and_folder() {
        let default = std::env::temp_dir().join("island-default");
        let chosen = std::env::temp_dir().join("island-chosen");
        let settings = serde_json::json!({ "options": { "dictation": { "model": "whisper-base", "modelDir": chosen.to_str() } } });
        assert_eq!(Place::read(&settings, &default).dir(), chosen.join("whisper-base-int8"));
        assert_eq!(Place::read(&serde_json::json!({}), &default).dir(), default.join("parakeet-tdt-0.6b-v3-int8"));
    }

    #[test]
    fn reads_the_chosen_microphone() {
        let with = |id: &str| serde_json::json!({ "options": { "dictation": { "microphone": id } } });
        assert_eq!(chosen_microphone(&with("wasapi:{0.0.1}")).as_deref(), Some("wasapi:{0.0.1}"));
        assert_eq!(chosen_microphone(&with("")), None, "empty means the system's default");
        assert_eq!(chosen_microphone(&serde_json::json!({})), None);
    }

    #[test]
    fn phases_serialize_for_the_page() {
        let json = serde_json::to_value(Phase::Listening { level: 0.5, seconds: 2.0 }).unwrap();
        assert_eq!(json, serde_json::json!({ "phase": "listening", "level": 0.5, "seconds": 2.0 }));
        assert_eq!(serde_json::to_value(Phase::NeedsModel).unwrap(), serde_json::json!({ "phase": "needsModel" }));
        let done = serde_json::to_value(Phase::Done { text: "Hi".into(), delivery: Some(Delivery::Copied) }).unwrap();
        assert_eq!(done, serde_json::json!({ "phase": "done", "text": "Hi", "delivery": "copied" }));
    }
}
