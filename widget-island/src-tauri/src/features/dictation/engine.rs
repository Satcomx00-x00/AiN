//! The microphone and the recognizer.

use std::{
    sync::{
        Arc, Mutex,
        atomic::Ordering,
        mpsc::{self, Receiver, Sender},
    },
    time::Instant,
};

use cpal::{
    FromSample, SampleFormat, SizedSample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use serde_json::Value;
use tauri::AppHandle;

use super::{Command, FEATURE, KEEP_WARM, MAX_SECONDS, Phase, Shared, chunk, deliver, lock, model};
use crate::shell::settings;

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
    let (model, dir) = (place.model(), place.dir());
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

/// Decodes chunks as they come; once the session finishes, delivers the text (unless cancelled meanwhile).
fn decoder(app: AppHandle, shared: Arc<Shared>, id: u64, chunks: Receiver<Vec<f32>>, finished: Receiver<()>) {
    let current = || shared.session.load(Ordering::SeqCst) == id;
    let recognizer = match recognizer(&shared) {
        Ok(r) => r,
        Err(message) => {
            return if current() {
                shared.publish(&app, Phase::Error { message })
            };
        }
    };
    let mut parts = Vec::new();
    for samples in chunks {
        if !current() {
            return;
        }
        parts.push(decode(&recognizer, &samples));
    }
    *lock(&shared.last_used) = Instant::now();
    // The chunk channel also closes on cancel; only a finished session gets delivered.
    if finished.try_recv().is_err() || !current() {
        return;
    }
    let text = chunk::join(&parts);
    let delivery = (!text.is_empty()).then(|| {
        let trailing = settings::option(&settings::current(&app), FEATURE, "trailingSpace").and_then(Value::as_bool).unwrap_or(true);
        deliver(&app, &if trailing { format!("{text} ") } else { text.clone() })
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
        let place = shared.place();
        if !place.model().installed(&place.dir()) {
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
        let spawned =
            std::thread::Builder::new().name("dictation-decode".into()).spawn(move || decoder(app2, shared2, id, chunks_rx, finished_rx));
        if let Err(e) = spawned {
            return shared.publish(app, Phase::Error { message: e.to_string() });
        }
        let chunker = chunk::Chunker::new(chunk::RATE, place.model().chunk_seconds);
        self.session = Some(Session { stream, captured, rate, chunker, chunks, finished, started: Instant::now() });
        shared.publish(app, Phase::Listening { level: 0.0, seconds: 0.0 });
    }

    /// Moves captured audio along to the decoder and reports the level; when idle, lets a cold model go.
    fn pump(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
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
