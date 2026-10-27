//! The transcript's lines, and which audio is worth recognizing.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::features::audio;

/// The oldest lines go past this many, so a call left running for hours stays light.
pub const MAX_LINES: usize = 2000;
/// Below this level (0–1, see `audio::level`) a chunk is taken for silence and not recognized.
const QUIET: f32 = 0.08;

/// A line heard, and when it started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Line {
    /// Milliseconds since the Unix epoch.
    pub at: u64,
    pub text: String,
}

/// Milliseconds since the Unix epoch, `ago` before now.
pub fn stamp(ago: Duration) -> u64 {
    SystemTime::now().checked_sub(ago).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

/// Whether anything audible plays in `samples`: their loudest tenth of a second is above silence.
pub fn audible(samples: &[f32], rate: u32) -> bool {
    let window = (rate as usize / 10).max(1);
    samples.chunks(window).any(|w| audio::level(w) > QUIET)
}

/// Adds `text` heard at `at`, unless blank, keeping at most `MAX_LINES`.
pub fn add(lines: &mut Vec<Line>, at: u64, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    lines.push(Line { at, text: text.to_string() });
    let over = lines.len().saturating_sub(MAX_LINES);
    lines.drain(..over);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_silence_but_not_a_short_sound() {
        let mut samples = vec![0.0_f32; 16_000];
        assert!(!audible(&samples, 16_000));
        assert!(!audible(&[], 16_000));
        samples[8_000..9_600].fill(0.2);
        assert!(audible(&samples, 16_000));
    }

    #[test]
    fn adds_trimmed_lines_and_drops_the_oldest() {
        let mut lines = Vec::new();
        add(&mut lines, 1, "  ");
        assert!(lines.is_empty());
        add(&mut lines, 2, " Hello. ");
        assert_eq!(lines, [Line { at: 2, text: "Hello.".into() }]);
        for i in 0..MAX_LINES as u64 {
            add(&mut lines, 10 + i, "more");
        }
        assert_eq!(lines.len(), MAX_LINES);
        assert_eq!(lines[0].at, 10);
    }

    #[test]
    fn stamps_in_the_past() {
        let now = stamp(Duration::ZERO);
        let before = stamp(Duration::from_secs(10));
        assert!((9_000..=11_000).contains(&(now - before)));
    }
}
