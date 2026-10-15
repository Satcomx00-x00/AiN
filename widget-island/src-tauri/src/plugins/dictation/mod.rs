//! Dictation: hold or tap a shortcut, speak, and the words are typed where the cursor is.
//! Speech is recognized on this machine through sherpa-onnx (as Orca does), by the model the user
//! picks (Parakeet, Whisper, SenseVoice, Moonshine); nothing leaves the computer. Each model is
//! downloaded once, when the user asks.
//!
//! A worker thread owns the microphone stream. While listening it feeds 16 kHz audio to a
//! decoder thread in 30 s chunks, so long dictations are mostly transcribed by the time they end.

mod chunk;
mod model;
#[cfg(windows)]
mod windows;

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Listener, Manager, Runtime, State,
    plugin::{Builder, TauriPlugin},
};

use super::{live::Live, popup, settings, worker::Worker};
use crate::Res;

pub use model::Status as ModelStatus;

/// The chosen model's status, the folder it is (or would be) stored in, and which models are downloaded.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelInfo {
    model: &'static str,
    dir: String,
    installed: Vec<&'static str>,
    #[serde(flatten)]
    status: ModelStatus,
}

/// Which model the settings pick, and the models folder it goes in.
#[derive(Clone, Copy)]
struct Choice<'a> {
    base: &'a std::path::Path,
    model: &'static model::Model,
}

#[derive(Clone, PartialEq)]
struct Place {
    base: PathBuf,
    model: &'static str,
}

impl Place {
    fn read(settings: &serde_json::Value, default: &std::path::Path) -> Self {
        let option = |key: &str| settings.pointer(&format!("/options/dictation/{key}")).and_then(|v| v.as_str());
        Self { base: model::base_in(option("modelDir"), default), model: model::find(option("model")).id }
    }

    fn choice(&self) -> Choice<'_> {
        Choice { base: &self.base, model: model::find(Some(self.model)) }
    }
}

impl Choice<'_> {
    fn dir(self) -> PathBuf {
        self.base.join(self.model.folder)
    }
}

pub const EVENT: &str = "dictation:state";
pub const MODEL_EVENT: &str = "dictation:model";
/// The command whose shortcut drives dictation.
const COMMAND: &str = "dictation.toggle";
#[cfg_attr(not(windows), allow(dead_code))]
const TICK: Duration = Duration::from_millis(50);
/// A forgotten dictation stops by itself.
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_SECONDS: f32 = 300.0;
/// The model takes about 1 GB of memory; it is let go after this long unused.
#[cfg_attr(not(windows), allow(dead_code))]
const KEEP_WARM: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
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
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Command {
    Start,
    Stop,
    Toggle,
    Cancel,
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
    #[cfg(windows)]
    recognizer: Mutex<Option<Arc<sherpa_onnx::OfflineRecognizer>>>,
    #[cfg_attr(not(windows), allow(dead_code))]
    last_used: Mutex<Instant>,
    /// Bumped by every start and cancel, so a stale decoder's result is thrown away.
    #[cfg_attr(not(windows), allow(dead_code))]
    session: AtomicU64,
    stop_download: AtomicBool,
    downloading: AtomicBool,
}

impl Shared {
    fn publish<R: Runtime>(&self, app: &AppHandle<R>, phase: Phase) {
        if self.phase.set(phase.clone()) {
            let _ = app.emit(EVENT, phase);
        }
    }

    fn place(&self) -> Place {
        lock(&self.place).clone()
    }

    fn info(place: &Place, status: ModelStatus) -> ModelInfo {
        let choice = place.choice();
        ModelInfo { model: choice.model.id, dir: choice.dir().to_string_lossy().into_owned(), installed: model::installed_in(&place.base), status }
    }

    fn publish_model<R: Runtime>(&self, app: &AppHandle<R>, status: ModelStatus) {
        let info = Self::info(&self.place(), status);
        if self.model.set(info.clone()) {
            let _ = app.emit(MODEL_EVENT, info);
        }
    }

    /// Re-reads the "Speech model" and "Model folder" settings; when they changed, that model is used
    /// from then on. A download in progress finishes first, then the new choice applies.
    fn follow_settings<R: Runtime>(&self, app: &AppHandle<R>, settings: &serde_json::Value) {
        let place = Place::read(settings, &self.default_dir);
        if *lock(&self.place) == place || self.downloading.load(Ordering::SeqCst) {
            return;
        }
        *lock(&self.place) = place.clone();
        #[cfg(windows)]
        lock(&self.recognizer).take();
        let choice = place.choice();
        self.publish_model(app, choice.model.status(&choice.dir()));
    }
}

struct Dictation {
    shared: Arc<Shared>,
    worker: Worker<Command>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
fn state(dictation: State<'_, Dictation>) -> Phase {
    dictation.shared.phase.get()
}

#[tauri::command]
fn model_status(dictation: State<'_, Dictation>) -> ModelInfo {
    dictation.shared.model.get()
}

/// Shows the model's folder (or the nearest one that exists) in the file manager.
#[tauri::command]
async fn open_model_dir(dictation: State<'_, Dictation>) -> Res<()> {
    let dir = dictation.shared.place().choice().dir();
    let existing = dir.ancestors().find(|p| p.is_dir()).map(std::path::Path::to_path_buf).unwrap_or(dir);
    #[cfg(windows)]
    std::process::Command::new("explorer").arg(existing).spawn()?;
    #[cfg(not(windows))]
    let _ = existing;
    Ok(())
}

#[tauri::command]
fn control(dictation: State<'_, Dictation>, command: Command) -> Res<()> {
    dictation.worker.send(command)
}

/// Starts downloading the model in the background; progress arrives as `dictation:model` events.
#[tauri::command]
fn download_model<R: Runtime>(app: AppHandle<R>, dictation: State<'_, Dictation>) -> Res<()> {
    let shared = Arc::clone(&dictation.shared);
    if shared.downloading.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    shared.stop_download.store(false, Ordering::SeqCst);
    let spawned = std::thread::Builder::new().name("dictation-download".into()).spawn({
        let shared = Arc::clone(&shared);
        move || {
            let place = shared.place();
            let (model, dir) = (place.choice().model, place.choice().dir());
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
fn delete_model<R: Runtime>(app: AppHandle<R>, dictation: State<'_, Dictation>) -> Res<()> {
    let shared = &dictation.shared;
    if shared.downloading.load(Ordering::SeqCst) {
        shared.stop_download.store(true, Ordering::SeqCst);
        return Ok(());
    }
    #[cfg(windows)]
    lock(&shared.recognizer).take();
    let choice = shared.place();
    let (model, dir) = (choice.choice().model, choice.choice().dir());
    model::remove(&dir)?;
    shared.publish_model(&app, model.status(&dir));
    Ok(())
}

/// What a shortcut event means for dictation. "Hold to talk" listens while the keys are held;
/// otherwise each press toggles.
pub fn command_for(kind: popup::ActionKind, hold: bool) -> Option<Command> {
    use popup::ActionKind::*;
    match kind {
        Tap => Some(Command::Toggle),
        Press if hold => Some(Command::Start),
        Press => Some(Command::Toggle),
        Release if hold => Some(Command::Stop),
        Release => None,
    }
}

fn on_shortcut<R: Runtime>(app: &AppHandle<R>, action: &popup::Action) {
    if action.command != COMMAND {
        return;
    }
    let hold = settings::current(app).pointer("/options/dictation/mode").and_then(|m| m.as_str()) == Some("hold");
    if let Some(command) = command_for(action.kind, hold)
        && let Err(e) = app.state::<Dictation>().worker.send(command)
    {
        eprintln!("island: dictation: {e}");
    }
}

#[cfg(windows)]
mod engine {
    //! The microphone and the recognizer.

    use std::sync::mpsc::{self, Receiver, Sender};

    use cpal::{
        FromSample, SampleFormat, SizedSample,
        traits::{DeviceTrait, HostTrait, StreamTrait},
    };

    use super::*;

    /// One dictation in progress.
    struct Session {
        stream: cpal::Stream,
        captured: Arc<Mutex<Vec<f32>>>,
        rate: u32,
        chunker: chunk::Chunker,
        chunks: Sender<Vec<f32>>,
        /// Tells the decoder the session ended normally (rather than being cancelled).
        finished: Sender<()>,
        started: Instant,
    }

    #[derive(Default)]
    pub struct Mic {
        session: Option<Session>,
    }

    fn open_stream<T>(device: &cpal::Device, config: cpal::StreamConfig, captured: Arc<Mutex<Vec<f32>>>) -> Result<cpal::Stream, String>
    where
        T: SizedSample + Send + 'static,
        f32: FromSample<T>,
    {
        let channels = usize::from(config.channels);
        device
            .build_input_stream::<T, _, _>(
                config,
                move |data: &[T], _: &cpal::InputCallbackInfo| lock(&captured).extend(chunk::mono(data, channels, f32::from_sample_)),
                |e| eprintln!("island: microphone: {e}"),
                None,
            )
            .map_err(|e| e.to_string())
    }

    fn open_mic(captured: Arc<Mutex<Vec<f32>>>) -> Result<(cpal::Stream, u32), String> {
        let device = cpal::default_host().default_input_device().ok_or("No microphone found")?;
        let supported = device.default_input_config().map_err(|e| e.to_string())?;
        let (format, config) = (supported.sample_format(), supported.config());
        let rate = config.sample_rate;
        let stream = match format {
            SampleFormat::F32 => open_stream::<f32>(&device, config, captured),
            SampleFormat::I16 => open_stream::<i16>(&device, config, captured),
            SampleFormat::I32 => open_stream::<i32>(&device, config, captured),
            SampleFormat::U16 => open_stream::<u16>(&device, config, captured),
            SampleFormat::U8 => open_stream::<u8>(&device, config, captured),
            SampleFormat::I8 => open_stream::<i8>(&device, config, captured),
            other => Err(format!("Unsupported microphone format {other}")),
        }?;
        stream.play().map_err(|e| e.to_string())?;
        Ok((stream, rate))
    }

    /// The recognizer, loading it if needed (a caller waits while another thread loads it).
    fn recognizer(shared: &Shared) -> Result<Arc<sherpa_onnx::OfflineRecognizer>, String> {
        let mut slot = lock(&shared.recognizer);
        *lock(&shared.last_used) = Instant::now();
        if let Some(r) = &*slot {
            return Ok(Arc::clone(r));
        }
        let place = shared.place();
        let (model, dir) = (place.choice().model, place.choice().dir());
        let path = |i| Some(model.path(&dir, i));
        let mut config = sherpa_onnx::OfflineRecognizerConfig::default();
        config.feat_config.sample_rate = chunk::RATE as i32;
        config.feat_config.feature_dim = 80;
        let m = &mut config.model_config;
        match model.kind {
            model::Kind::Transducer => {
                m.transducer.encoder = path(0);
                m.transducer.decoder = path(1);
                m.transducer.joiner = path(2);
            }
            model::Kind::Whisper => {
                m.whisper.encoder = path(0);
                m.whisper.decoder = path(1);
                // No language: Whisper detects it.
                m.whisper.task = Some("transcribe".into());
                m.whisper.tail_paddings = -1;
            }
            model::Kind::SenseVoice => {
                m.sense_voice.model = path(0);
                m.sense_voice.language = Some("auto".into());
                m.sense_voice.use_itn = true;
            }
            model::Kind::Moonshine => {
                m.moonshine.preprocessor = path(0);
                m.moonshine.encoder = path(1);
                m.moonshine.uncached_decoder = path(2);
                m.moonshine.cached_decoder = path(3);
            }
        }
        m.tokens = path(model.files.len() - 1);
        config.model_config.num_threads = 2;
        config.model_config.provider = Some("cpu".into());
        config.decoding_method = Some("greedy_search".into());
        let r = sherpa_onnx::OfflineRecognizer::create(&config).ok_or("The speech model couldn't be loaded; try downloading it again")?;
        let r = Arc::new(r);
        *slot = Some(Arc::clone(&r));
        Ok(r)
    }

    fn decode(recognizer: &sherpa_onnx::OfflineRecognizer, samples: &[f32]) -> String {
        // An offline stream is single-use: one per chunk.
        let stream = recognizer.create_stream();
        stream.accept_waveform(chunk::RATE as i32, samples);
        recognizer.decode(&stream);
        stream.get_result().map(|r| r.text.trim().to_string()).unwrap_or_default()
    }

    /// Decodes chunks as they come; once the session finishes, types the text (unless cancelled meanwhile).
    fn decoder<R: Runtime>(app: AppHandle<R>, shared: Arc<Shared>, id: u64, chunks: Receiver<Vec<f32>>, finished: Receiver<()>) {
        let current = || shared.session.load(Ordering::SeqCst) == id;
        let recognizer = match recognizer(&shared) {
            Ok(r) => r,
            Err(message) => return if current() { shared.publish(&app, Phase::Error { message }) },
        };
        let mut parts = Vec::new();
        for samples in chunks {
            if !current() {
                return;
            }
            parts.push(decode(&recognizer, &samples));
        }
        *lock(&shared.last_used) = Instant::now();
        // The chunk channel also closes on cancel; only a finished session gets typed.
        if finished.try_recv().is_err() || !current() {
            return;
        }
        let text = chunk::join(&parts);
        if !text.is_empty() {
            let trailing = settings::current(&app).pointer("/options/dictation/trailingSpace").and_then(|v| v.as_bool()).unwrap_or(true);
            super::windows::type_text(&if trailing { format!("{text} ") } else { text.clone() });
        }
        shared.publish(&app, Phase::Done { text });
    }

    impl Mic {
        pub fn step<R: Runtime>(&mut self, app: &AppHandle<R>, shared: &Arc<Shared>, command: Option<Command>) {
            let listening = self.session.is_some();
            match command {
                Some(Command::Start | Command::Toggle) if !listening => self.start(app, shared),
                Some(Command::Stop | Command::Toggle) if listening => self.stop(app, shared),
                Some(Command::Cancel) => self.cancel(app, shared),
                Some(_) => {}
                None => self.pump(app, shared),
            }
        }

        fn start<R: Runtime>(&mut self, app: &AppHandle<R>, shared: &Arc<Shared>) {
            let place = shared.place();
            let choice = place.choice();
            if !choice.model.installed(&choice.dir()) {
                return shared.publish(app, Phase::NeedsModel);
            }
            if matches!(shared.phase.get(), Phase::Transcribing) {
                return;
            }
            let captured = Arc::new(Mutex::new(Vec::new()));
            let (stream, rate) = match open_mic(Arc::clone(&captured)) {
                Ok(s) => s,
                Err(message) => return shared.publish(app, Phase::Error { message }),
            };
            let id = shared.session.fetch_add(1, Ordering::SeqCst) + 1;
            let (chunks, chunks_rx) = mpsc::channel();
            let (finished, finished_rx) = mpsc::channel();
            let (app2, shared2) = (app.clone(), Arc::clone(shared));
            // The decoder loads the model while the user speaks.
            let spawned = std::thread::Builder::new()
                .name("dictation-decode".into())
                .spawn(move || decoder(app2, shared2, id, chunks_rx, finished_rx));
            if let Err(e) = spawned {
                return shared.publish(app, Phase::Error { message: e.to_string() });
            }
            let chunker = chunk::Chunker::new(chunk::RATE, choice.model.chunk_seconds);
            self.session = Some(Session { stream, captured, rate, chunker, chunks, finished, started: Instant::now() });
            shared.publish(app, Phase::Listening { level: 0.0, seconds: 0.0 });
        }

        /// Moves captured audio along to the decoder and reports the level; when idle, lets a cold model go.
        fn pump<R: Runtime>(&mut self, app: &AppHandle<R>, shared: &Arc<Shared>) {
            let Some(session) = &mut self.session else {
                if lock(&shared.last_used).elapsed() > KEEP_WARM && !matches!(shared.phase.get(), Phase::Transcribing) {
                    lock(&shared.recognizer).take();
                }
                return;
            };
            let raw = std::mem::take(&mut *lock(&session.captured));
            let audio = chunk::resample(&raw, session.rate, chunk::RATE);
            for ready in session.chunker.push(&audio) {
                let _ = session.chunks.send(ready);
            }
            let seconds = session.started.elapsed().as_secs_f32();
            // Rounded so the event only fires when something visible changes.
            let level = (chunk::level(&audio) * 20.0).round() / 20.0;
            shared.publish(app, Phase::Listening { level, seconds: seconds.floor() });
            if seconds >= MAX_SECONDS {
                self.stop(app, shared);
            }
        }

        fn stop<R: Runtime>(&mut self, app: &AppHandle<R>, shared: &Arc<Shared>) {
            self.pump(app, shared);
            let Some(Session { stream, mut chunker, chunks, finished, .. }) = self.session.take() else { return };
            drop(stream);
            if let Some(rest) = chunker.flush() {
                let _ = chunks.send(rest);
            }
            let _ = finished.send(());
            shared.publish(app, Phase::Transcribing);
        }

        fn cancel<R: Runtime>(&mut self, app: &AppHandle<R>, shared: &Arc<Shared>) {
            shared.session.fetch_add(1, Ordering::SeqCst);
            self.session = None;
            shared.publish(app, Phase::Idle);
        }
    }
}

#[cfg(windows)]
fn spawn<R: Runtime>(app: AppHandle<R>, shared: Arc<Shared>) -> std::io::Result<Worker<Command>> {
    super::worker::spawn("dictation", TICK, engine::Mic::default, move |mic, command| mic.step(&app, &shared, command))
}

#[cfg(not(windows))]
fn spawn<R: Runtime>(_: AppHandle<R>, _: Arc<Shared>) -> std::io::Result<Worker<Command>> {
    Ok(Worker::unsupported())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("dictation")
        .invoke_handler(tauri::generate_handler![state, model_status, control, download_model, delete_model, open_model_dir])
        .setup(|app, _| {
            let default_dir = app.path().app_data_dir()?.join("models");
            let place = Place::read(&settings::current(app), &default_dir);
            let choice = place.choice();
            let info = Shared::info(&place, choice.model.status(&choice.dir()));
            let shared = Arc::new(Shared {
                phase: Live::new(Phase::Idle),
                model: Live::new(info),
                place: Mutex::new(place),
                default_dir,
                #[cfg(windows)]
                recognizer: Mutex::new(None),
                last_used: Mutex::new(Instant::now()),
                session: AtomicU64::new(0),
                stop_download: AtomicBool::new(false),
                downloading: AtomicBool::new(false),
            });
            let worker = spawn(app.clone(), Arc::clone(&shared))?;
            let (handle, followed) = (app.clone(), Arc::clone(&shared));
            app.listen_any(settings::EVENT, move |event| match serde_json::from_str(event.payload()) {
                Ok(value) => followed.follow_settings(&handle, &value),
                Err(e) => eprintln!("island: dictation: unreadable settings event: {e}"),
            });
            app.manage(Dictation { shared, worker });
            let handle = app.clone();
            app.listen_any(popup::ACTION_EVENT, move |event| match serde_json::from_str::<popup::Action>(event.payload()) {
                Ok(action) => on_shortcut(&handle, &action),
                Err(e) => eprintln!("island: dictation: unreadable shortcut event: {e}"),
            });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use popup::ActionKind::*;

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
        let info = ModelInfo { model: "whisper-small", dir: "D:\\Models".into(), installed: vec!["parakeet-v3"], status: ModelStatus::Downloading { received: 1, total: 2 } };
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
        let place = Place::read(&settings, &default);
        assert_eq!(place.choice().dir(), chosen.join("whisper-base-int8"));
        let place = Place::read(&serde_json::json!({}), &default);
        assert_eq!(place.choice().dir(), default.join("parakeet-tdt-0.6b-v3-int8"));
    }

    #[test]
    fn phases_serialize_for_the_page() {
        let json = serde_json::to_value(Phase::Listening { level: 0.5, seconds: 2.0 }).unwrap();
        assert_eq!(json, serde_json::json!({ "phase": "listening", "level": 0.5, "seconds": 2.0 }));
        assert_eq!(serde_json::to_value(Phase::NeedsModel).unwrap(), serde_json::json!({ "phase": "needsModel" }));
    }
}
