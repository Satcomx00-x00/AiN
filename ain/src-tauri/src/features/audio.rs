//! Audio helpers shared by the features that listen (dictation) and speak (read aloud).

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
    fn resamples_linearly() {
        assert_eq!(resample(&[0.0, 1.0], 16_000, 16_000), [0.0, 1.0]);
        assert_eq!(resample(&[0.0; 48_000], 48_000, 16_000).len(), 16_000);
        assert_eq!(resample(&[0.0, 1.0], 1, 2), [0.0, 0.5, 1.0, 1.0]);
    }
}
