//! The microphone and the recognizer.

use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::Ordering,
        mpsc::{self, Receiver, Sender},
    },
    time::Instant,
};

use serde_json::Value;
use tauri::AppHandle;

use super::{Command, FEATURE, KEEP_WARM, MAX_SECONDS, Phase, Shared, SpeechModels, chunk, deliver, lock, model, pastes};
use crate::{
    features::microphone,
    shell::{
        providers::{self, Engine, Remote},
        settings,
    },
};

/// One dictation in progress.
struct Session {
    stream: cpal::Stream,
    captured: microphone::Captured,
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

/// Loads the recognizer of `model`, stored in `dir`.
pub fn load(model: &'static model::Model, dir: &Path) -> Result<sherpa_onnx::OfflineRecognizer, String> {
    let path = |i| Some(model.path(dir, i));
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
    sherpa_onnx::OfflineRecognizer::create(&config)
        .ok_or_else(|| "The speech model couldn't be loaded; try downloading it again".to_string())
}

fn decode(recognizer: &sherpa_onnx::OfflineRecognizer, samples: &[f32]) -> String {
    // An offline stream is single-use: one per chunk.
    let stream = recognizer.create_stream();
    stream.accept_waveform(chunk::RATE as i32, samples);
    recognizer.decode(&stream);
    stream.get_result().map(|r| r.text.trim().to_string()).unwrap_or_default()
}

/// What turns speech into text: the model on this machine, or a provider's.
pub enum Recognizer {
    Local(Arc<sherpa_onnx::OfflineRecognizer>),
    Remote(Remote),
}

impl Recognizer {
    /// Loads `engine`: the chosen speech model of `models` (loaded once and shared), or a provider's.
    pub fn open(models: &SpeechModels, engine: Engine) -> Result<Self, String> {
        match engine {
            Engine::Local => models.engine().map(Self::Local),
            Engine::Remote(remote) => Ok(Self::Remote(remote)),
        }
    }

    /// What is said in `samples`, mono at 16 kHz.
    pub fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
        match self {
            Self::Local(recognizer) => Ok(decode(recognizer, samples)),
            Self::Remote(remote) => remote.transcribe(samples, chunk::RATE),
        }
    }
}

/// Decodes chunks as they come; once the session finishes, delivers the text (unless cancelled meanwhile).
fn decoder(app: AppHandle, shared: Arc<Shared>, id: u64, engine: Engine, chunks: Receiver<Vec<f32>>, finished: Receiver<()>) {
    let current = || shared.session.load(Ordering::SeqCst) == id;
    let local = engine == Engine::Local;
    let recognizer = match Recognizer::open(&shared.models, engine) {
        Ok(r) => r,
        Err(message) => {
            return if current() {
                shared.publish(&app, Phase::Error { message })
            };
        }
    };
    let mut parts = Vec::new();
    // A failure is told once the session ends: while listening, the level keeps the pill busy.
    let mut failed = None;
    for samples in chunks {
        if !current() {
            return;
        }
        if failed.is_none() {
            match recognizer.transcribe(&samples) {
                Ok(text) => parts.push(text),
                Err(message) => failed = Some(message),
            }
        }
    }
    if local {
        shared.models.touch();
    }
    // The chunk channel also closes on cancel; only a finished session gets delivered.
    if finished.try_recv().is_err() || !current() {
        return;
    }
    if let Some(message) = failed {
        return shared.publish(&app, Phase::Error { message });
    }
    let text = chunk::join(&parts);
    let delivery = (!text.is_empty()).then(|| {
        let settings = settings::current(&app);
        let trailing = settings::option(&settings, FEATURE, "trailingSpace").and_then(Value::as_bool).unwrap_or(true);
        deliver(&app, &if trailing { format!("{text} ") } else { text.clone() }, pastes(&settings))
    });
    shared.publish(&app, Phase::Done { text, delivery });
}

impl Mic {
    pub fn step(&mut self, app: &AppHandle, shared: &Arc<Shared>, command: Option<Command>) {
        let listening = self.session.is_some();
        match command {
            Some(Command::Start | Command::Toggle) if !listening => self.start(app, shared),
            Some(Command::Stop | Command::Toggle) if listening => self.stop(app, shared),
            Some(Command::Cancel) => self.cancel(app, shared),
            Some(_) => {}
            None => self.pump(app, shared),
        }
    }

    fn start(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        let settings = settings::current(app);
        let engine = match providers::chosen(&settings, FEATURE) {
            Ok(engine) => engine,
            Err(message) => return shared.publish(app, Phase::Error { message }),
        };
        if engine == Engine::Local && !shared.models.ready() {
            return shared.publish(app, Phase::NeedsModel);
        }
        if matches!(shared.phase.get(), Phase::Transcribing) {
            return;
        }
        let captured = Arc::new(Mutex::new(Vec::new()));
        let chosen = super::chosen_microphone(&settings);
        let (stream, rate) = match microphone::open(chosen.as_deref(), Arc::clone(&captured)) {
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
            .spawn(move || decoder(app2, shared2, id, engine, chunks_rx, finished_rx));
        if let Err(e) = spawned {
            return shared.publish(app, Phase::Error { message: e.to_string() });
        }
        let chunker = chunk::Chunker::new(chunk::RATE, shared.models.chosen().0.chunk_seconds);
        self.session = Some(Session { stream, captured, rate, chunker, chunks, finished, started: Instant::now() });
        shared.publish(app, Phase::Listening { level: 0.0, seconds: 0.0 });
    }

    /// Moves captured audio along to the decoder and reports the level; when idle, lets a cold model go.
    fn pump(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        let Some(session) = &mut self.session else {
            if !matches!(shared.phase.get(), Phase::Transcribing) {
                shared.models.let_cold_go(KEEP_WARM);
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

    fn stop(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        self.pump(app, shared);
        let Some(Session { stream, mut chunker, chunks, finished, .. }) = self.session.take() else { return };
        drop(stream);
        if let Some(rest) = chunker.flush() {
            let _ = chunks.send(rest);
        }
        let _ = finished.send(());
        shared.publish(app, Phase::Transcribing);
    }

    fn cancel(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        shared.session.fetch_add(1, Ordering::SeqCst);
        self.session = None;
        shared.publish(app, Phase::Idle);
    }
}
