//! The recording and the recognizer.

use std::{
    sync::{
        Arc,
        atomic::Ordering,
        mpsc::{self, Receiver, Sender},
    },
    time::{Duration, Instant},
};

use tauri::AppHandle;

use super::{Command, FEATURE, Phase, Shared, loopback::Loopback, text};
use crate::{
    features::{
        audio,
        dictation::{self, Recognizer, SpeechModels, chunk},
    },
    shell::{
        providers::{self, Engine},
        settings,
    },
};

/// Short enough for lines to show up soon after they are said, long enough for whole sentences.
const CHUNK_SECONDS: f32 = 8.0;

/// A chunk to recognize, and when it started (ms since the Unix epoch).
struct Chunk {
    at: u64,
    samples: Vec<f32>,
}

/// One recording in progress.
struct Session {
    loopback: Loopback,
    chunker: chunk::Chunker,
    chunks: Sender<Chunk>,
    started: Instant,
}

/// Sends `samples` (at the recognizer's rate) along, stamped with when they began.
fn send(chunks: &Sender<Chunk>, samples: Vec<f32>) {
    let ago = Duration::from_secs_f32(samples.len() as f32 / chunk::RATE as f32);
    let _ = chunks.send(Chunk { at: text::stamp(ago), samples });
}

#[derive(Default)]
pub struct Listener {
    session: Option<Session>,
}

/// Loads the recognizer while the first chunk records, then recognizes chunks as they come and
/// adds their lines, until the session ends.
fn decoder(app: AppHandle, shared: Arc<Shared>, id: u64, engine: Engine, models: Arc<SpeechModels>, chunks: Receiver<Chunk>) {
    let current = || shared.session.load(Ordering::SeqCst) == id;
    let local = engine == Engine::Local;
    let recognizer = match Recognizer::open(&models, engine) {
        Ok(r) => r,
        // The worker sees the error and stops recording.
        Err(message) => return shared.publish(&app, Phase::Error { message }),
    };
    for Chunk { at, samples } in chunks {
        if !current() {
            return;
        }
        if !text::audible(&samples, chunk::RATE) {
            continue;
        }
        match recognizer.transcribe(&samples) {
            Ok(heard) => shared.update_lines(&app, |lines| text::add(lines, at, &heard)),
            // The worker sees the error and stops recording.
            Err(message) => return shared.publish(&app, Phase::Error { message }),
        }
        if local {
            models.touch();
        }
    }
    if current() && shared.phase.get() == Phase::Finishing {
        shared.publish(&app, Phase::Idle);
    }
}

impl Listener {
    pub fn step(&mut self, app: &AppHandle, shared: &Arc<Shared>, command: Option<Command>) {
        let listening = self.session.is_some();
        match command {
            Some(Command::Start | Command::Toggle) if !listening => self.start(app, shared),
            Some(Command::Stop | Command::Toggle) if listening => self.stop(app, shared),
            Some(Command::Clear) => shared.update_lines(app, Vec::clear),
            Some(_) => {}
            None => self.pump(app, shared),
        }
    }

    fn start(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        if shared.phase.get() == Phase::Finishing {
            return;
        }
        let Some(models) = dictation::speech_models(app) else { return };
        let engine = match providers::chosen(&settings::current(app), FEATURE) {
            Ok(engine) => engine,
            Err(message) => return shared.publish(app, Phase::Error { message }),
        };
        if engine == Engine::Local && !models.ready() {
            return shared.publish(app, Phase::NeedsModel);
        }
        let loopback = match Loopback::open() {
            Ok(l) => l,
            Err(message) => return shared.publish(app, Phase::Error { message }),
        };
        let id = shared.session.fetch_add(1, Ordering::SeqCst) + 1;
        let (chunks, chunks_rx) = mpsc::channel();
        let (app2, shared2) = (app.clone(), Arc::clone(shared));
        let spawned = std::thread::Builder::new()
            .name("transcript-decode".into())
            .spawn(move || decoder(app2, shared2, id, engine, models, chunks_rx));
        if let Err(e) = spawned {
            return shared.publish(app, Phase::Error { message: e.to_string() });
        }
        let chunker = chunk::Chunker::new(chunk::RATE, CHUNK_SECONDS);
        self.session = Some(Session { loopback, chunker, chunks, started: Instant::now() });
        shared.publish(app, Phase::Listening { level: 0.0, seconds: 0.0 });
    }

    /// Moves recorded audio along to the decoder and reports the level; stops when the recording
    /// or the recognizer failed.
    fn pump(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        let Some(session) = &mut self.session else { return };
        if matches!(shared.phase.get(), Phase::Error { .. }) {
            self.session = None;
            return;
        }
        if !session.loopback.alive() {
            self.session = None;
            return shared.publish(app, Phase::Error { message: "The sound server stopped".into() });
        }
        let audio = audio::resample(&session.loopback.take(), session.loopback.rate(), chunk::RATE);
        for ready in session.chunker.push(&audio) {
            send(&session.chunks, ready);
        }
        // Rounded so the event only fires when something visible changes.
        let level = (audio::level(&audio) * 20.0).round() / 20.0;
        let seconds = session.started.elapsed().as_secs_f32().floor();
        shared.publish(app, Phase::Listening { level, seconds });
    }

    fn stop(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        self.pump(app, shared);
        let Some(Session { loopback, mut chunker, chunks, .. }) = self.session.take() else { return };
        drop(loopback);
        if let Some(rest) = chunker.flush() {
            send(&chunks, rest);
        }
        shared.publish(app, Phase::Finishing);
    }
}
