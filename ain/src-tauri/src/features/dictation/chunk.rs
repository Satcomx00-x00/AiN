//! Audio shaping for the recognizer: mono 16 kHz, decoded in bounded chunks while the user talks.
//! Same approach as Orca's offline dictation.

pub use crate::features::audio::resample;

/// The rate Parakeet expects.
pub const RATE: u32 = 16_000;
/// Cutting mid-word hurts the transcript, so each cut goes in the quietest spot of the chunk's
/// last seconds. The window is pause-sized: shorter ones find quiet inside words (plosives).
const SEARCH_SECONDS: f32 = 5.0;
const WINDOW_SECONDS: f32 = 0.1;

/// Averages interleaved frames down to one channel.
pub fn mono<T: Copy>(data: &[T], channels: usize, to_f32: impl Fn(T) -> f32) -> impl Iterator<Item = f32> {
    let channels = channels.max(1);
    data.chunks(channels).map(move |frame| frame.iter().map(|&s| to_f32(s)).sum::<f32>() / frame.len() as f32)
}

/// Loudness of a stretch of audio in 0–1, on a decibel scale from -50 dB (silence) to -10 dB.
pub fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
    ((20.0 * rms.max(1e-6).log10() + 50.0) / 40.0).clamp(0.0, 1.0)
}

/// Buffers 16 kHz audio and hands out chunks ready to decode.
pub struct Chunker {
    buffered: Vec<f32>,
    limit: usize,
    search: usize,
    window: usize,
}

impl Chunker {
    /// Offline models decode a whole chunk at once; long dictations are split into pieces `chunk_seconds` long.
    pub fn new(rate: u32, chunk_seconds: f32) -> Self {
        let samples = |seconds: f32| (seconds * rate as f32).round() as usize;
        Self {
            buffered: Vec::new(),
            limit: samples(chunk_seconds).max(1),
            search: samples(SEARCH_SECONDS),
            window: samples(WINDOW_SECONDS).max(1),
        }
    }

    /// Adds samples; returns the chunks that are now full.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.buffered.extend_from_slice(samples);
        let mut ready = Vec::new();
        while self.buffered.len() >= self.limit {
            let cut = self.quiet_cut();
            let tail = self.buffered.split_off(cut);
            ready.push(std::mem::replace(&mut self.buffered, tail));
        }
        ready
    }

    /// Whatever is left, if anything.
    pub fn flush(&mut self) -> Option<Vec<f32>> {
        (!self.buffered.is_empty()).then(|| std::mem::take(&mut self.buffered))
    }

    /// The middle of the quietest window in the chunk's last seconds; at least 1 so `push` always progresses.
    fn quiet_cut(&self) -> usize {
        let limit = self.limit.min(self.buffered.len());
        let hop = (self.window / 2).max(1);
        let mut best = (f32::INFINITY, limit);
        let mut start = limit.saturating_sub(self.search);
        while start + self.window <= limit {
            let energy: f32 = self.buffered[start..start + self.window].iter().map(|s| s * s).sum();
            if energy < best.0 {
                best = (energy, start + self.window / 2);
            }
            start += hop;
        }
        best.1.max(1)
    }
}

/// Joins chunk transcripts into one line of text.
pub fn join(parts: &[String]) -> String {
    parts.iter().map(|p| p.trim()).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn averages_channels() {
        let stereo = [0.5_f32, -0.5, 1.0, 0.0];
        assert_eq!(mono(&stereo, 2, |s| s).collect::<Vec<_>>(), [0.0, 0.5]);
        assert_eq!(mono(&[i16::MAX], 1, |s| f32::from(s) / 32768.0).count(), 1);
    }

    #[test]
    fn measures_loudness() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0.0; 160]), 0.0);
        assert_eq!(level(&[1.0; 160]), 1.0);
        assert!((0.3..0.8).contains(&level(&[0.03; 160])));
    }

    #[test]
    fn cuts_long_audio_in_the_quietest_spot() {
        let rate = 100; // 30 s = 3000 samples, search the last 500, 10-sample window.
        let mut chunker = Chunker::new(rate, 30.0);
        let mut audio = vec![0.5_f32; 3200];
        audio[2700..2710].fill(0.0);
        let ready = chunker.push(&audio);
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].len(), 2705);
        assert_eq!(chunker.flush().map(|r| r.len()), Some(495));
        assert_eq!(chunker.flush(), None);
    }

    #[test]
    fn keeps_short_audio_until_flushed() {
        let mut chunker = Chunker::new(RATE, 30.0);
        assert!(chunker.push(&[0.1; 1600]).is_empty());
        assert_eq!(chunker.flush().map(|r| r.len()), Some(1600));
    }

    #[test]
    fn joins_transcripts() {
        assert_eq!(join(&[" Hello ".into(), String::new(), "world.".into()]), "Hello world.");
    }
}
