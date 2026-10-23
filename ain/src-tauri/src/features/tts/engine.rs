//! The voice and the speakers: sherpa-onnx writes the speech sentence by sentence on a thread of its
//! own, and each sentence plays as soon as it is ready.

use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use cpal::{
    FromSample, SampleFormat, SizedSample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use serde_json::Value;
use tauri::AppHandle;

use super::{FEATURE, KEEP_WARM, Phase, Request, Shared, lock, model, selection};
use crate::{features::audio, shell::settings};

/// What the speakers still have to play, at their rate.
type Queue = Arc<Mutex<VecDeque<f32>>>;

/// The speakers keep a little audio buffered: speech is over once the queue stays empty this long.
const TAIL: Duration = Duration::from_millis(300);
const SPEEDS: std::ops::RangeInclusive<f32> = 0.5..=2.0;

/// One text being read.
struct Playback {
    _stream: cpal::Stream,
    queue: Queue,
    text: String,
    /// Until the voice has written the whole text (or failed, or was stopped).
    writing: Arc<AtomicBool>,
    /// Since when the queue is empty.
    drained: Option<Instant>,
}

#[derive(Default)]
pub struct Speaker {
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

fn open_stream<T>(device: &cpal::Device, config: cpal::StreamConfig, queue: Queue) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let channels = usize::from(config.channels).max(1);
    device
        .build_output_stream::<T, _, _>(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                let mut queue = lock(&queue);
                for frame in data.chunks_mut(channels) {
                    frame.fill(T::from_sample_(queue.pop_front().unwrap_or(0.0)));
                }
            },
            |e| eprintln!("island: speakers: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

/// The system's default speakers, playing what `queue` holds; and their rate.
fn open_speakers(queue: Queue) -> Result<(cpal::Stream, u32), String> {
    let device = cpal::default_host().default_output_device().ok_or("No speakers found")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let (format, config) = (supported.sample_format(), supported.config());
    let rate = config.sample_rate;
    let stream = match format {
        SampleFormat::F32 => open_stream::<f32>(&device, config, queue),
        SampleFormat::I16 => open_stream::<i16>(&device, config, queue),
        SampleFormat::I32 => open_stream::<i32>(&device, config, queue),
        SampleFormat::U16 => open_stream::<u16>(&device, config, queue),
        SampleFormat::U8 => open_stream::<u8>(&device, config, queue),
        SampleFormat::I8 => open_stream::<i8>(&device, config, queue),
        other => Err(format!("Unsupported speaker format {other}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, rate))
}

/// The voice, loading it if needed (a caller waits while another thread loads it).
fn voice(shared: &Shared) -> Result<Arc<sherpa_onnx::OfflineTts>, String> {
    let mut slot = lock(&shared.voice);
    *lock(&shared.last_used) = Instant::now();
    if let Some(v) = &*slot {
        return Ok(Arc::clone(v));
    }
    let place = shared.place();
    let (model, dir) = (place.model(), place.dir());
    let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let mut config = sherpa_onnx::OfflineTtsConfig { max_num_sentences: 1, silence_scale: 0.2, ..Default::default() };
    let m = &mut config.model;
    match model.kind {
        model::Kind::Vits => {
            m.vits.model = path(model.file);
            m.vits.tokens = path(model::TOKENS);
            m.vits.data_dir = path(model::ESPEAK);
        }
        model::Kind::Kokoro => {
            m.kokoro.model = path(model.file);
            m.kokoro.voices = path(model::VOICES);
            m.kokoro.tokens = path(model::TOKENS);
            m.kokoro.data_dir = path(model::ESPEAK);
        }
        model::Kind::Kitten => {
            m.kitten.model = path(model.file);
            m.kitten.voices = path(model::VOICES);
            m.kitten.tokens = path(model::TOKENS);
            m.kitten.data_dir = path(model::ESPEAK);
        }
    }
    m.num_threads = 2;
    m.provider = Some("cpu".into());
    let v = sherpa_onnx::OfflineTts::create(&config).ok_or("The voice couldn't be loaded; try downloading it again")?;
    let v = Arc::new(v);
    *slot = Some(Arc::clone(&v));
    Ok(v)
}

/// Writes `text` into `queue` at `rate`, a sentence at a time, until done or no longer current.
fn write(app: AppHandle, shared: Arc<Shared>, id: u64, text: String, rate: u32, queue: Queue, writing: Arc<AtomicBool>) {
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
        let (queue, still) = (Arc::clone(&queue), current.clone());
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
    *lock(&shared.last_used) = Instant::now();
    if let Err(message) = result
        && current()
    {
        shared.publish(&app, Phase::Error { message });
    }
    writing.store(false, Ordering::SeqCst);
}

impl Speaker {
    pub fn step(&mut self, app: &AppHandle, shared: &Arc<Shared>, request: Option<Request>) {
        match request {
            Some(Request::Toggle) if self.playback.is_some() => self.stop(app, shared),
            Some(Request::Toggle) => match selection::selected() {
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
        let place = shared.place();
        if !place.model().installed(&place.dir()) {
            return shared.publish(app, Phase::NeedsModel);
        }
        let queue = Queue::default();
        let (stream, rate) = match open_speakers(Arc::clone(&queue)) {
            Ok(s) => s,
            Err(message) => return shared.publish(app, Phase::Error { message }),
        };
        let id = shared.session.fetch_add(1, Ordering::SeqCst) + 1;
        let writing = Arc::new(AtomicBool::new(true));
        let spawned = std::thread::Builder::new().name("tts-write".into()).spawn({
            let (app, shared, text, queue, writing) =
                (app.clone(), Arc::clone(shared), text.clone(), Arc::clone(&queue), Arc::clone(&writing));
            move || write(app, shared, id, text, rate, queue, writing)
        });
        if let Err(e) = spawned {
            return shared.publish(app, Phase::Error { message: e.to_string() });
        }
        self.playback = Some(Playback { _stream: stream, queue, text, writing, drained: None });
        shared.publish(app, Phase::Preparing);
    }

    /// Reports when speech starts and ends; when idle, lets a cold voice go.
    fn pump(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        let Some(playback) = &mut self.playback else {
            if lock(&shared.last_used).elapsed() > KEEP_WARM {
                lock(&shared.voice).take();
            }
            return;
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
