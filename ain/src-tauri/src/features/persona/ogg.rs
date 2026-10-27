//! Just enough of Ogg (RFC 3533) to carry one Opus stream each way: a writer that puts each packet
//! on a page of its own, and a reader that takes pages as they arrive, whole or in pieces.

const MAGIC: &[u8; 4] = b"OggS";
const HEADER: usize = 27;
const BEGINS: u8 = 0x02;
const MAX_SEGMENTS: usize = 255;

/// The Ogg checksum: CRC-32, polynomial 0x04c11db7, unreflected, from zero.
const CRC: [u32; 256] = {
    let mut table = [0; 256];
    let mut i = 0;
    while i < 256 {
        let mut r = (i as u32) << 24;
        let mut bit = 0;
        while bit < 8 {
            r = if r & 0x8000_0000 != 0 { (r << 1) ^ 0x04c1_1db7 } else { r << 1 };
            bit += 1;
        }
        table[i] = r;
        i += 1;
    }
    table
};

fn crc(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0, |crc, &b| (crc << 8) ^ CRC[((crc >> 24) as u8 ^ b) as usize])
}

/// Writes one logical stream, a page per packet.
#[derive(Debug)]
pub struct Writer {
    serial: u32,
    sequence: u32,
}

impl Writer {
    pub const fn new(serial: u32) -> Self {
        Self { serial, sequence: 0 }
    }

    /// The page holding `packet`, which ends at `granule` (in samples at 48 kHz for Opus).
    /// Packets are at most 255 × 255 bytes long, far above any Opus packet.
    pub fn page(&mut self, packet: &[u8], granule: u64) -> Vec<u8> {
        let mut lacing = vec![255u8; packet.len() / 255];
        lacing.push((packet.len() % 255) as u8);
        debug_assert!(lacing.len() <= MAX_SEGMENTS, "packet too long for one page");
        let mut page = Vec::with_capacity(HEADER + lacing.len() + packet.len());
        page.extend_from_slice(MAGIC);
        page.push(0);
        page.push(if self.sequence == 0 { BEGINS } else { 0 });
        page.extend_from_slice(&granule.to_le_bytes());
        page.extend_from_slice(&self.serial.to_le_bytes());
        page.extend_from_slice(&self.sequence.to_le_bytes());
        page.extend_from_slice(&[0; 4]);
        page.push(lacing.len() as u8);
        page.extend_from_slice(&lacing);
        page.extend_from_slice(packet);
        let sum = crc(&page);
        page[22..26].copy_from_slice(&sum.to_le_bytes());
        self.sequence += 1;
        page
    }
}

/// Reads the packets of a stream fed in arbitrary pieces; damaged pages are skipped.
#[derive(Debug, Default)]
pub struct Reader {
    buffered: Vec<u8>,
    /// A packet continuing on the next page.
    partial: Vec<u8>,
}

impl Reader {
    /// Takes more of the stream; returns the packets it completes.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.buffered.extend_from_slice(bytes);
        let mut packets = Vec::new();
        while let Some(used) = self.page(&mut packets) {
            self.buffered.drain(..used);
        }
        packets
    }

    /// Reads the page at the front, if whole; returns how many bytes to drop (the page, or garbage
    /// up to the next one).
    fn page(&mut self, packets: &mut Vec<Vec<u8>>) -> Option<usize> {
        let b = &self.buffered;
        let Some(start) = b.windows(MAGIC.len()).position(|w| w == MAGIC) else {
            // Keep a tail that may be the start of the next magic.
            return (b.len() >= MAGIC.len()).then(|| b.len() + 1 - MAGIC.len());
        };
        if start > 0 {
            return Some(start);
        }
        if b.len() < HEADER {
            return None;
        }
        let segments = usize::from(b[26]);
        let lacing = b.get(HEADER..HEADER + segments)?;
        let size = HEADER + segments + lacing.iter().map(|&l| usize::from(l)).sum::<usize>();
        let page = b.get(..size)?;
        let mut blank = page.to_vec();
        blank[22..26].fill(0);
        if crc(&blank).to_le_bytes() != page[22..26] {
            return Some(1);
        }
        let mut at = HEADER + segments;
        for &l in lacing {
            let l = usize::from(l);
            self.partial.extend_from_slice(&page[at..at + l]);
            at += l;
            if l < 255 {
                packets.push(std::mem::take(&mut self.partial));
            }
        }
        Some(size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksums_as_ogg_does() {
        assert_eq!(crc(b""), 0);
        // CRC-32/MPEG-2 without its initial value and final inversion ("123456789").
        assert_eq!(crc(b"123456789"), 0x89a1_897f);
    }

    #[test]
    fn writes_pages_that_read_back() {
        let mut writer = Writer::new(7);
        let long = vec![3u8; 600];
        let empty: Vec<u8> = Vec::new();
        let (first, second, third) = (writer.page(b"OpusHead", 0), writer.page(&long, 960), writer.page(&empty, 1920));
        assert_eq!((first[5], second[5]), (BEGINS, 0), "only the first page begins the stream");
        assert_eq!(&second[27..30], [255, 255, 90], "600 bytes are laced as 255 + 255 + 90");
        let mut reader = Reader::default();
        let all = [first, second, third].concat();
        assert_eq!(reader.push(&all), [b"OpusHead".to_vec(), long, empty]);
    }

    #[test]
    fn reads_pages_split_anywhere_and_skips_garbage() {
        let mut writer = Writer::new(1);
        let stream = [b"junk".to_vec(), writer.page(b"one", 0), writer.page(b"two", 0)].concat();
        let mut reader = Reader::default();
        let packets: Vec<_> = stream.chunks(5).flat_map(|piece| reader.push(piece)).collect();
        assert_eq!(packets, [b"one".to_vec(), b"two".to_vec()]);
    }

    #[test]
    fn skips_a_damaged_page() {
        let mut writer = Writer::new(1);
        let mut bad = writer.page(b"bad", 0);
        let last = bad.len() - 1;
        bad[last] ^= 0xff;
        let mut reader = Reader::default();
        assert_eq!(reader.push(&[bad, writer.page(b"good", 0)].concat()), [b"good".to_vec()]);
    }

    /// A page with these lacing values and data, checksummed.
    fn raw_page(lacing: &[u8], data: &[u8]) -> Vec<u8> {
        let mut page = [MAGIC.as_slice(), &[0, 0], &[0; 8], &[1, 0, 0, 0], &[0; 8], &[lacing.len() as u8], lacing, data].concat();
        let sum = crc(&page);
        page[22..26].copy_from_slice(&sum.to_le_bytes());
        page
    }

    #[test]
    fn joins_a_packet_spanning_pages() {
        // A page ending on a 255 lacing value continues its packet on the next page.
        let mut reader = Reader::default();
        assert!(reader.push(&raw_page(&[255], &[1; 255])).is_empty());
        assert_eq!(reader.push(&raw_page(&[1], &[2])), [[vec![1; 255], vec![2]].concat()]);
    }
}
