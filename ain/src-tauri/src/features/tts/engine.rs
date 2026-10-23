//! Reading a text: sherpa-onnx writes the speech sentence by sentence on a thread of its own, and
//! each sentence plays on the speakers as soon as it is ready.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::Value;
use tauri::AppHandle;

use super::{FEATURE, KEEP_WARM, Phase, Request, Shared, lock, speakers};
use crate::{features::audio, shell::settings};

/// The speakers keep a little audio buffered: speech is over once the queue stays empty this long.
const TAIL: Duration = Duration::from_millis(300);
const SPEEDS: std::ops::RangeInclusive<f32> = 0.5..=2.0;

/// One text being read.
struct Playback {
    _stream: cpal::Stream,
    queue: speakers::Queue,
    text: String,
    /// Until the voice has written the whole text (or failed, or was stopped).
    writing: Arc<AtomicBool>,
    /// Since when the queue is empty.
    drained: Option<Instant>,
}

/// Where the text to read comes from when the shortcut is pressed.
pub type Selection = fn() -> Option<String>;

pub struct Speaker {
    selection: Selection,
    playback: Option<Playback>,
}

/// How the settings want the text read.
struct Voice {
    speaker: i32,
    speed: f32,
}

impl Voice {
    fn read(settings: &Value) -> Self {
        let option = |key| settings::option(settings, FEATURE, key);
        Self {
            speaker: option("voice").and_then(Value::as_i64).and_then(|v| i32::try_from(v).ok()).unwrap_or(0).max(0),
            speed: option("speed").and_then(Value::as_f64).map_or(1.0, |s| (s as f32).clamp(*SPEEDS.start(), *SPEEDS.end())),
        }
    }
}

/// The voice for the chosen model, loading it if needed.
fn voice(shared: &Shared) -> Result<Arc<sherpa_onnx::OfflineTts>, String> {
    shared.models.engine(|model, dir| {
        let mut config =
            sherpa_onnx::OfflineTtsConfig { model: model.config(dir), max_num_sentences: 1, silence_scale: 0.2, ..Default::default() };
        config.model.num_threads = 2;
        config.model.provider = Some("cpu".into());
        sherpa_onnx::OfflineTts::create(&config).ok_or_else(|| "The voice couldn't be loaded; try downloading it again".to_string())
    })
}

/// A text to write into the speakers' queue at their rate, as reading `id`.
struct Job {
    id: u64,
    text: String,
    rate: u32,
    queue: speakers::Queue,
    writing: Arc<AtomicBool>,
}

/// Writes the job's text a sentence at a time, until done or no longer current.
fn write(app: AppHandle, shared: Arc<Shared>, job: Job) {
    let Job { id, text, rate, queue, writing } = job;
    let current = {
        let shared = Arc::clone(&shared);
        move || shared.session.load(Ordering::SeqCst) == id
    };
    let settings = Voice::read(&settings::current(&app));
    let result = voice(&shared).and_then(|tts| {
        let from = u32::try_from(tts.sample_rate()).unwrap_or(rate);
        let config = sherpa_onnx::GenerationConfig {
            sid: settings.speaker.min(tts.num_speakers().max(1) - 1),
            speed: settings.speed,
            ..Default::default()
        };
        let still = current.clone();
        let on_sentence = move |samples: &[f32], _progress: f32| {
            if still() {
                lock(&queue).extend(audio::resample(samples, from, rate));
            }
            still()
        };
        // A stopped reading ends early: what it returns then doesn't matter.
        match tts.generate_with_config(&text, &config, Some(on_sentence)) {
            None if current() => Err("The voice couldn't read this text".to_string()),
            _ => Ok(()),
        }
    });
    shared.models.touch();
    if let Err(message) = result
        && current()
    {
        shared.publish(&app, Phase::Error { message });
    }
    writing.store(false, Ordering::SeqCst);
}

impl Speaker {
    pub fn new(selection: Selection) -> Self {
        Self { selection, playback: None }
    }

    pub fn step(&mut self, app: &AppHandle, shared: &Arc<Shared>, request: Option<Request>) {
        match request {
            Some(Request::Toggle) if self.playback.is_some() => self.stop(app, shared),
            Some(Request::Toggle) => match (self.selection)() {
                Some(text) => self.speak(app, shared, text),
                None => shared.publish(app, Phase::NothingSelected),
            },
            Some(Request::Say(text)) => self.speak(app, shared, text),
            Some(Request::Stop) => self.stop(app, shared),
            None => self.pump(app, shared),
        }
    }

    fn speak(&mut self, app: &AppHandle, shared: &Arc<Shared>, text: String) {
        self.halt(shared);
        if !shared.models.ready() {
            return shared.publish(app, Phase::NeedsModel);
        }
        let queue = speakers::Queue::default();
        let (stream, rate) = match speakers::open(Arc::clone(&queue)) {
            Ok(s) => s,
            Err(message) => return shared.publish(app, Phase::Error { message }),
        };
        let id = shared.session.fetch_add(1, Ordering::SeqCst) + 1;
        let writing = Arc::new(AtomicBool::new(true));
        let job = Job { id, text: text.clone(), rate, queue: Arc::clone(&queue), writing: Arc::clone(&writing) };
        let (app2, shared2) = (app.clone(), Arc::clone(shared));
        if let Err(e) = std::thread::Builder::new().name("tts-write".into()).spawn(move || write(app2, shared2, job)) {
            return shared.publish(app, Phase::Error { message: e.to_string() });
        }
        self.playback = Some(Playback { _stream: stream, queue, text, writing, drained: None });
        shared.publish(app, Phase::Preparing);
    }

    /// Reports when speech starts and ends; when idle, lets a cold voice go.
    fn pump(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        let Some(playback) = &mut self.playback else {
            return shared.models.let_cold_go(KEEP_WARM);
        };
        if !lock(&playback.queue).is_empty() {
            playback.drained = None;
            if matches!(shared.phase.get(), Phase::Preparing) {
                shared.publish(app, Phase::Speaking { text: playback.text.clone() });
            }
            return;
        }
        let drained = *playback.drained.get_or_insert_with(Instant::now);
        if playback.writing.load(Ordering::SeqCst) || drained.elapsed() < TAIL {
            return;
        }
        self.playback = None;
        // A failure stays on show.
        if !matches!(shared.phase.get(), Phase::Error { .. }) {
            shared.publish(app, Phase::Idle);
        }
    }

    /// Stops reading at once: the voice stops writing and the speakers go quiet.
    fn halt(&mut self, shared: &Shared) {
        shared.session.fetch_add(1, Ordering::SeqCst);
        self.playback = None;
    }

    fn stop(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        self.halt(shared);
        shared.publish(app, Phase::Idle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_voice_and_a_sane_speed() {
        let with = |options: Value| Voice::read(&serde_json::json!({ "options": { "tts": options } }));
        let voice = with(serde_json::json!({ "voice": 3, "speed": 1.25 }));
        assert_eq!((voice.speaker, voice.speed), (3, 1.25));
        let wild = with(serde_json::json!({ "voice": -2, "speed": 9 }));
        assert_eq!((wild.speaker, wild.speed), (0, 2.0));
        let none = with(serde_json::json!({}));
        assert_eq!((none.speaker, none.speed), (0, 1.0));
    }
}
