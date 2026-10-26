//! WAV, the audio format every OpenAI-compatible server takes and gives: 16-bit mono to send
//! speech out, and whatever PCM comes back mixed down to mono samples.

/// 16-bit mono PCM at `rate`.
pub fn encode(samples: &[f32], rate: u32) -> Vec<u8> {
    let data = u32::try_from(samples.len() * 2).unwrap_or(u32::MAX);
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&data.saturating_add(36).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16).to_le_bytes());
    }
    out
}

/// What a WAV file holds, as `(mono samples, rate)`.
pub type Decoded = (Vec<f32>, u32);

#[derive(Clone, Copy)]
struct Format {
    float: bool,
    channels: usize,
    rate: u32,
    bits: u16,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn format(chunk: &[u8]) -> Result<Format, String> {
    let bad = || "The provider sent an unreadable WAV header".to_string();
    let tag = u16_at(chunk, 0).ok_or_else(bad)?;
    // WAVE_FORMAT_EXTENSIBLE keeps the real tag in its sub-format.
    let tag = if tag == 0xFFFE { u16_at(chunk, 24).ok_or_else(bad)? } else { tag };
    let format = Format {
        float: tag == 3,
        channels: usize::from(u16_at(chunk, 2).ok_or_else(bad)?).max(1),
        rate: u32_at(chunk, 4).ok_or_else(bad)?,
        bits: u16_at(chunk, 14).ok_or_else(bad)?,
    };
    match (tag, format.bits) {
        (1, 8 | 16 | 24 | 32) | (3, 32) if format.rate > 0 => Ok(format),
        _ => Err(format!("The provider sent audio this app can't play (WAV format {tag}, {} bits)", format.bits)),
    }
}

fn sample(f: Format, b: &[u8]) -> f32 {
    match (f.float, f.bits) {
        (true, _) => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        (false, 8) => (f32::from(b[0]) - 128.0) / 128.0,
        (false, 16) => f32::from(i16::from_le_bytes([b[0], b[1]])) / 32_768.0,
        (false, 24) => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
        (false, _) => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
    }
}

/// Reads PCM (8/16/24/32-bit) or float WAV, mixing its channels down. A streamed file's data size
/// is often a placeholder: the data then runs to the end.
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err("The provider didn't send WAV audio".into());
    }
    let (mut at, mut fmt) = (12, None);
    while let (Some(id), Some(size)) = (bytes.get(at..at + 4), u32_at(bytes, at + 4)) {
        let body = at + 8;
        let end = body.saturating_add(size as usize).min(bytes.len());
        if id == b"fmt " {
            fmt = Some(format(&bytes[body..end])?);
        } else if id == b"data" {
            let f = fmt.ok_or("The provider's WAV has no format")?;
            let frame = usize::from(f.bits / 8) * f.channels;
            let samples = bytes[body..end]
                .chunks_exact(frame)
                .map(|frame| frame.chunks_exact(usize::from(f.bits / 8)).map(|b| sample(f, b)).sum::<f32>() / f.channels as f32)
                .collect();
            return Ok((samples, f.rate));
        }
        at = end + (size as usize & 1);
    }
    Err("The provider's WAV has no audio".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_speech() {
        let (samples, rate) = decode(&encode(&[0.0, 0.5, -0.5, 1.0, -2.0], 16_000)).unwrap();
        assert_eq!(rate, 16_000);
        let near = |a: f32, b: f32| (a - b).abs() < 1e-3;
        assert!(samples.iter().zip([0.0, 0.5, -0.5, 1.0, -1.0]).all(|(&a, b)| near(a, b)), "{samples:?}");
    }

    #[test]
    fn mixes_stereo_down_and_reads_a_streamed_size() {
        let mut wav = encode(&[], 24_000);
        wav[22] = 2; // stereo
        wav[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        for s in [16_384i16, 0, -16_384, -16_384] {
            wav.extend_from_slice(&s.to_le_bytes());
        }
        assert_eq!(decode(&wav).unwrap(), (vec![0.25, -0.5], 24_000));
    }

    #[test]
    fn skips_other_chunks_and_refuses_what_isnt_wav() {
        let plain = encode(&[0.5], 8_000);
        let mut wav = plain[..36].to_vec();
        wav.extend_from_slice(b"LIST\x03\x00\x00\x00abc\x00");
        wav.extend_from_slice(&plain[36..]);
        assert_eq!(decode(&wav).unwrap().0.len(), 1);
        assert!(decode(b"ID3 mp3 bytes").is_err());
        assert!(decode(&plain[..36]).is_err());
    }
}
