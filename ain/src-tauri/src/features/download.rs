//! Model downloads shared by the features that run models on this machine (dictation, read aloud):
//! streamed over HTTPS, hashed on the fly, stoppable, reporting progress along the way.

use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;

/// How often download progress is reported.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Missing { size: u64 },
    Downloading { received: u64, total: u64 },
    Ready,
    Error { message: String },
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

/// What `fetch` wrote: its length and SHA-256, in lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub size: u64,
    pub sha256: String,
}

/// Streams `url` into `out`, hashing it, calling `progress(received)` at most every `PROGRESS_EVERY`.
pub fn fetch(url: &str, out: &mut impl Write, cancel: &AtomicBool, mut progress: impl FnMut(u64)) -> Result<Fetched, DownloadError> {
    let response = ureq::get(url).call().map_err(|e| DownloadError::Network(e.to_string()))?;
    let mut body = response.into_body().into_reader();
    let mut hash = Sha256::new();
    let mut buf = vec![0; 1 << 16];
    let mut received = 0;
    let mut reported = Instant::now();
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
            progress(received);
        }
    }
    out.flush()?;
    Ok(Fetched { size: received, sha256: hex(&hash.finalize()) })
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The models folder: the one the user picked when it is an absolute path, else `default`.
pub fn base_in(chosen: Option<&str>, default: &Path) -> PathBuf {
    let base = chosen.map(str::trim).filter(|c| !c.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute());
    base.unwrap_or_else(|| default.to_path_buf())
}

/// Removes a model's folder.
pub fn remove(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_in_the_chosen_folder_or_the_default() {
        let default = std::env::temp_dir().join("island-default");
        let chosen = std::env::temp_dir().join("island-chosen");
        assert_eq!(base_in(chosen.to_str(), &default), chosen);
        assert_eq!(base_in(None, &default), default);
        assert_eq!(base_in(Some("  "), &default), default);
        assert_eq!(base_in(Some("relative/folder"), &default), default);
    }

    #[test]
    fn removing_a_missing_folder_is_fine() {
        let dir = std::env::temp_dir().join(format!("island-download-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("inner")).unwrap();
        remove(&dir).unwrap();
        assert!(!dir.exists());
        remove(&dir).unwrap();
    }

    #[test]
    fn hashes_as_lowercase_hex() {
        assert_eq!(hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
