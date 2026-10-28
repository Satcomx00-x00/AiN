//! Model downloads shared by the features that run models on this machine (dictation, read aloud,
//! spelling): streamed over HTTPS, hashed on the fly, stoppable, reporting progress along the way.
//!
//! Without internet, they come from the models source instead (`shell::net::models_source`): a
//! folder (or `file://` URL) or an HTTP server laid out like the models folder, e.g. the models
//! folder of a connected machine, copied. Each file is checked against its known hash all the same.

use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;

use crate::shell::net;

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
    #[error("network: {0}. Without internet, set a models source in Settings › General › Network")]
    Network(String),
    #[error("not in the models source: {0}")]
    NotInSource(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// What `fetch` wrote: its length and SHA-256, in lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub size: u64,
    pub sha256: String,
}

/// `relative` in the models source when one is set, else `official`.
pub fn source(official: String, relative: &str) -> String {
    net::models_source().map_or(official, |base| format!("{}/{relative}", base.trim_end_matches(['/', '\\'])))
}

/// The file a local source names: `file://…`, or a path (anything but http and https).
fn local(url: &str) -> Option<PathBuf> {
    if let Some(path) = url.strip_prefix("file://") {
        return Some(PathBuf::from(path));
    }
    (!url.starts_with("http://") && !url.starts_with("https://")).then(|| PathBuf::from(url))
}

/// `folder` in a local models source, when there is one and it has it.
pub fn local_folder(folder: &str) -> Option<PathBuf> {
    local(&source(String::new(), folder)).filter(|p| p.is_dir())
}

/// Copies the folder `from` into `to`, recursively.
pub fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Streams `url` into `out`, hashing it, calling `progress(received)` at most every `PROGRESS_EVERY`.
pub fn fetch(url: &str, out: &mut impl Write, cancel: &AtomicBool, mut progress: impl FnMut(u64)) -> Result<Fetched, DownloadError> {
    let mut body: Box<dyn Read> = match local(url) {
        Some(path) => Box::new(fs::File::open(&path).map_err(|e| DownloadError::NotInSource(format!("{} ({e})", path.display())))?),
        None => Box::new(net::agent().get(url).call().map_err(|e| DownloadError::Network(e.to_string()))?.into_body().into_reader()),
    };
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

/// A file known in advance by its size and SHA-256, as served at a pinned revision.
pub struct Pinned {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub const fn pinned(name: &'static str, size: u64, sha256: &'static str) -> Pinned {
    Pinned { name, size, sha256 }
}

/// Whether every file is in `dir` at its full size (hashes were checked when it was downloaded).
pub fn complete(dir: &Path, files: &[Pinned]) -> bool {
    files.iter().all(|f| fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.size))
}

/// Downloads the files missing from `dir`, each from `url(file)`, calling `progress(received, total)`
/// along the way; each must match its size and hash.
pub fn fetch_pinned(
    dir: &Path,
    files: &[Pinned],
    url: impl Fn(&Pinned) -> String,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), DownloadError> {
    let total = files.iter().map(|f| f.size).sum();
    let mut done = 0;
    for file in files {
        if !fs::metadata(dir.join(file.name)).is_ok_and(|m| m.len() == file.size) {
            let matches = |fetched: &Fetched| fetched.size == file.size && fetched.sha256 == file.sha256;
            fetch_file(dir, file.name, &url(file), matches, cancel, |received| progress(done + received, total))?;
        }
        done += file.size;
        progress(done, total);
    }
    Ok(())
}

/// Downloads `url` into `dir` as `name`: it streams into `<name>.part`, is hashed on the fly, and is
/// renamed only once `matches` accepts what came.
pub fn fetch_file(
    dir: &Path,
    name: &'static str,
    url: &str,
    matches: impl FnOnce(&Fetched) -> bool,
    cancel: &AtomicBool,
    progress: impl FnMut(u64),
) -> Result<(), DownloadError> {
    fs::create_dir_all(dir)?;
    let part = dir.join(format!("{name}.part"));
    let result = (|| {
        let mut out = io::BufWriter::new(File::create(&part)?);
        let fetched = fetch(url, &mut out, cancel, progress)?;
        drop(out);
        if !matches(&fetched) {
            return Err(DownloadError::Corrupt(name));
        }
        fs::rename(&part, dir.join(name))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
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
    fn reads_local_sources() {
        assert_eq!(local("file:///srv/models/a.onnx"), Some(PathBuf::from("/srv/models/a.onnx")));
        assert_eq!(local("/srv/models/a.onnx"), Some(PathBuf::from("/srv/models/a.onnx")));
        assert_eq!(local("https://example.com/a.onnx"), None);
        assert_eq!(local("http://mirror.lan/a.onnx"), None);
    }

    #[test]
    fn fetches_and_copies_from_a_folder() {
        let dir = std::env::temp_dir().join(format!("island-source-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("model/inner")).unwrap();
        fs::write(dir.join("model/inner/abc.txt"), b"abc").unwrap();
        let mut out = Vec::new();
        let fetched = fetch(dir.join("model/inner/abc.txt").to_str().unwrap(), &mut out, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!((out.as_slice(), fetched.size), (b"abc".as_slice(), 3));
        assert_eq!(fetched.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let missing = fetch(dir.join("gone").to_str().unwrap(), &mut out, &AtomicBool::new(false), |_| {}).unwrap_err();
        assert!(matches!(missing, DownloadError::NotInSource(_)));
        copy_dir(&dir.join("model"), &dir.join("copy")).unwrap();
        assert_eq!(fs::read(dir.join("copy/inner/abc.txt")).unwrap(), b"abc");
        remove(&dir).unwrap();
    }

    #[test]
    fn hashes_as_lowercase_hex() {
        assert_eq!(hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
