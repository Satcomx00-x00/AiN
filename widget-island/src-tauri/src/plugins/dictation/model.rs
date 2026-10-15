//! The speech model: NVIDIA Parakeet TDT 0.6B v3 (25 languages), int8, run by sherpa-onnx.
//! Downloaded on request from Hugging Face at a pinned revision and checked against known hashes.

use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use serde::Serialize;
use sha2::{Digest, Sha256};

pub const NAME: &str = "parakeet-tdt-0.6b-v3-int8";
const REPO: &str = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const REVISION: &str = "2bda32ec70b097a55adaa07d9a7173915b43cc78";
/// How often download progress is reported.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

pub struct ModelFile {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub const FILES: [ModelFile; 4] = [
    ModelFile { name: "encoder.int8.onnx", size: 652_184_281, sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247" },
    ModelFile { name: "decoder.int8.onnx", size: 11_845_275, sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e" },
    ModelFile { name: "joiner.int8.onnx", size: 6_355_277, sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3" },
    ModelFile { name: "tokens.txt", size: 93_939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d" },
];

pub fn total_size() -> u64 {
    FILES.iter().map(|f| f.size).sum()
}

pub fn url(file: &str) -> String {
    format!("https://huggingface.co/{REPO}/resolve/{REVISION}/{file}?download=true")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Missing { size: u64 },
    Downloading { received: u64, total: u64 },
    Ready,
    Error { message: String },
}

/// Ready once every file is there at its full size (hashes were checked when it was downloaded).
pub fn installed(dir: &Path) -> bool {
    FILES.iter().all(|f| fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.size))
}

pub fn status(dir: &Path) -> Status {
    if installed(dir) { Status::Ready } else { Status::Missing { size: total_size() } }
}

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("download stopped")]
    Cancelled,
    #[error("{0} is damaged (checksum mismatch), try again")]
    Corrupt(&'static str),
    #[error("network: {0}")]
    Network(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Downloads the missing files into `dir`, calling `progress(received, total)` along the way.
/// Each file streams into `<name>.part`, is hashed on the fly, and is renamed only if it matches.
pub fn download(dir: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<(), DownloadError> {
    fs::create_dir_all(dir)?;
    let total = total_size();
    let mut done = 0;
    let mut reported = Instant::now();
    for file in &FILES {
        let path = dir.join(file.name);
        if fs::metadata(&path).is_ok_and(|m| m.len() == file.size) {
            done += file.size;
            continue;
        }
        let part = dir.join(format!("{}.part", file.name));
        let result = (|| {
            let response = ureq::get(&url(file.name)).call().map_err(|e| DownloadError::Network(e.to_string()))?;
            let mut body = response.into_body().into_reader();
            let mut out = io::BufWriter::new(File::create(&part)?);
            let mut hash = Sha256::new();
            let mut buf = vec![0; 1 << 16];
            let mut received = 0;
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(DownloadError::Cancelled);
                }
                let n = body.read(&mut buf).map_err(|e| DownloadError::Network(e.to_string()))?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])?;
                hash.update(&buf[..n]);
                received += n as u64;
                if reported.elapsed() >= PROGRESS_EVERY {
                    reported = Instant::now();
                    progress(done + received, total);
                }
            }
            out.flush()?;
            drop(out);
            if received != file.size || hex(&hash.finalize()) != file.sha256 {
                return Err(DownloadError::Corrupt(file.name));
            }
            fs::rename(&part, &path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&part);
        }
        result?;
        done += file.size;
        progress(done, total);
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Removes the model's folder.
pub fn remove(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

pub fn path(dir: &Path, file: usize) -> String {
    let p: PathBuf = dir.join(FILES[file].name);
    p.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_the_revision() {
        assert_eq!(
            url("tokens.txt"),
            "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/tokens.txt?download=true"
        );
        assert_eq!(total_size(), 670_478_772);
    }

    #[test]
    fn missing_until_every_file_is_complete() {
        let dir = std::env::temp_dir().join(format!("island-model-test-{}", std::process::id()));
        let _ = remove(&dir);
        assert_eq!(status(&dir), Status::Missing { size: total_size() });
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("tokens.txt"), "partial").unwrap();
        assert!(!installed(&dir));
        remove(&dir).unwrap();
        remove(&dir).unwrap();
    }

    #[test]
    fn hashes_as_lowercase_hex() {
        assert_eq!(hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
