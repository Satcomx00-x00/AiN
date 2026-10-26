//! The audio PersonaPlex speaks: 24 kHz mono Opus in an Ogg stream (RFC 7845), each way.

use super::ogg;

/// PersonaPlex hears and speaks at 24 kHz, mono.
pub const RATE: u32 = 24_000;
/// One model step: 80 ms.
pub const FRAME: usize = 1_920;
/// Ogg Opus counts time at 48 kHz, whatever the rate.
const GRANULE_PER_FRAME: u64 = FRAME as u64 * 48_000 / RATE as u64;
/// Room for the longest Opus frame (120 ms) at 24 kHz.
const MAX_DECODED: usize = RATE as usize * 120 / 1_000;
const MAX_PACKET: usize = 4_000;
/// What sets this stream apart from others on the server; any value will do.
const SERIAL: u32 = 0x4149_4e21;

fn failed(what: &str) -> impl Fn(opus::Error) -> String + '_ {
    move |e| format!("Couldn't {what} the audio: {e}")
}

/// The identification header: version 1, mono, no pre-skip, 24 kHz input, no gain, family 0.
fn opus_head() -> Vec<u8> {
    [b"OpusHead".as_slice(), &[1, 1], &0u16.to_le_bytes(), &RATE.to_le_bytes(), &0i16.to_le_bytes(), &[0]].concat()
}

/// The comment header: who wrote the stream, and no comments.
fn opus_tags() -> Vec<u8> {
    const VENDOR: &[u8] = b"AiN";
    [b"OpusTags".as_slice(), &(VENDOR.len() as u32).to_le_bytes(), VENDOR, &0u32.to_le_bytes()].concat()
}

/// The microphone's side: 24 kHz samples in, Ogg pages out.
pub struct Encoder {
    opus: opus::Encoder,
    ogg: ogg::Writer,
    pending: Vec<f32>,
    /// The end of the audio sent so far, in 48 kHz samples.
    granule: u64,
    headed: bool,
}

impl Encoder {
    pub fn new() -> Result<Self, String> {
        let opus = opus::Encoder::new(RATE, opus::Channels::Mono, opus::Application::Voip).map_err(failed("encode"))?;
        Ok(Self { opus, ogg: ogg::Writer::new(SERIAL), pending: Vec::with_capacity(FRAME * 2), granule: 0, headed: false })
    }

    /// The pages to send for `samples`: the stream's headers first, then a page per whole frame;
    /// the rest waits for more audio. Empty when there is nothing to send yet.
    pub fn push(&mut self, samples: &[f32]) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        if !std::mem::replace(&mut self.headed, true) {
            out.extend(self.ogg.page(&opus_head(), 0));
            out.extend(self.ogg.page(&opus_tags(), 0));
        }
        self.pending.extend_from_slice(samples);
        while self.pending.len() >= FRAME {
            let packet = self.opus.encode_vec_float(&self.pending[..FRAME], MAX_PACKET).map_err(failed("encode"))?;
            self.pending.drain(..FRAME);
            self.granule += GRANULE_PER_FRAME;
            out.extend(self.ogg.page(&packet, self.granule));
        }
        Ok(out)
    }
}

/// The speakers' side: Ogg pages in, 24 kHz samples out.
pub struct Decoder {
    opus: opus::Decoder,
    ogg: ogg::Reader,
    scratch: Vec<f32>,
}

impl Decoder {
    pub fn new() -> Result<Self, String> {
        let opus = opus::Decoder::new(RATE, opus::Channels::Mono).map_err(failed("decode"))?;
        Ok(Self { opus, ogg: ogg::Reader::default(), scratch: vec![0.0; MAX_DECODED] })
    }

    /// The samples in this piece of the stream; its headers are skipped.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<f32>, String> {
        let mut out = Vec::new();
        for packet in self.ogg.push(bytes) {
            if packet.starts_with(b"OpusHead") || packet.starts_with(b"OpusTags") {
                continue;
            }
            let n = self.opus.decode_float(&packet, &mut self.scratch, false).map_err(failed("decode"))?;
            out.extend_from_slice(&self.scratch[..n]);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 440 Hz tone at 24 kHz.
    fn tone(len: usize) -> Vec<f32> {
        (0..len).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / RATE as f32).sin() * 0.5).collect()
    }

    #[test]
    fn writes_the_headers_once_then_whole_frames() {
        let mut encoder = Encoder::new().unwrap();
        let headers = encoder.push(&[]).unwrap();
        assert_eq!(ogg::Reader::default().push(&headers), [opus_head(), opus_tags()]);
        assert!(encoder.push(&tone(FRAME - 1)).unwrap().is_empty(), "less than a frame waits");
        assert_eq!(ogg::Reader::default().push(&encoder.push(&tone(1)).unwrap()).len(), 1, "then one frame is sent");
    }

    #[test]
    fn decodes_what_it_encodes() {
        let (mut encoder, mut decoder) = (Encoder::new().unwrap(), Decoder::new().unwrap());
        let stream = encoder.push(&tone(FRAME * 4)).unwrap();
        // Arriving in pieces, as messages do.
        let samples: Vec<f32> = stream.chunks(100).flat_map(|piece| decoder.push(piece).unwrap()).collect();
        assert_eq!(samples.len(), FRAME * 4);
        let loud = samples[FRAME * 2..].iter().map(|s| s * s).sum::<f32>() / (FRAME * 2) as f32;
        assert!(loud > 0.05, "the tone comes back, not silence ({loud})");
    }

    #[test]
    fn says_when_the_audio_is_damaged() {
        let mut decoder = Decoder::new().unwrap();
        let page = ogg::Writer::new(1).page(&[0xff; 3], 0);
        assert!(decoder.push(&page).unwrap_err().starts_with("Couldn't decode the audio"));
    }
}
