//! Audio helpers shared by the features that listen (dictation, conversation) and speak (read
//! aloud, conversation).

/// The host the microphones and speakers are opened on: ALSA on Linux, so device ids saved in the
/// settings stay the same now that the PipeWire host is built in (for `transcript`); the system's
/// own elsewhere.
pub fn host() -> cpal::Host {
    #[cfg(target_os = "linux")]
    if let Ok(host) = cpal::host_from_id(cpal::HostId::Alsa) {
        return host;
    }
    cpal::default_host()
}

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

/// Linear resampling, good enough for speech.
pub fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if samples.is_empty() || from == 0 || to == 0 || from == to {
        return samples.to_vec();
    }
    let len = ((samples.len() as f64 * f64::from(to) / f64::from(from)).round() as usize).max(1);
    let ratio = f64::from(from) / f64::from(to);
    (0..len)
        .map(|i| {
            let at = i as f64 * ratio;
            let left = (at.floor() as usize).min(samples.len() - 1);
            let right = (left + 1).min(samples.len() - 1);
            let weight = (at - left as f64) as f32;
            samples[left] * (1.0 - weight) + samples[right] * weight
        })
        .collect()
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
    fn resamples_linearly() {
        assert_eq!(resample(&[0.0, 1.0], 16_000, 16_000), [0.0, 1.0]);
        assert_eq!(resample(&[0.0; 48_000], 48_000, 16_000).len(), 16_000);
        assert_eq!(resample(&[0.0, 1.0], 1, 2), [0.0, 0.5, 1.0, 1.0]);
    }
}
