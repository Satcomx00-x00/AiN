//! The voice models the user can pick from, all run by sherpa-onnx. Each comes as one `.tar.bz2`
//! from sherpa-onnx's `tts-models` release, downloaded on request and unpacked into its own folder.

use std::{
    fs::{self, File},
    io::{self, BufReader},
    path::Path,
    sync::atomic::AtomicBool,
};

use bzip2::read::BzDecoder;

use crate::features::download;
pub use crate::features::download::{DownloadError, Status, base_in, remove};

const RELEASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";
/// Every model reads its phonemes through espeak-ng, from this folder of its own.
pub const ESPEAK: &str = "espeak-ng-data";
pub const TOKENS: &str = "tokens.txt";
/// Kokoro's and Kitten's speakers.
pub const VOICES: &str = "voices.bin";

/// How sherpa-onnx runs a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Piper voices: model, tokens; one speaker each.
    Vits,
    /// model, voices, tokens.
    Kokoro,
    /// model, voices, tokens.
    Kitten,
}

impl Kind {
    /// The files and folders beside the model file.
    fn companions(self) -> &'static [&'static str] {
        match self {
            Self::Vits => &[TOKENS, ESPEAK],
            Self::Kokoro | Self::Kitten => &[VOICES, TOKENS, ESPEAK],
        }
    }
}

pub struct Model {
    /// What the "Voice model" setting stores.
    pub id: &'static str,
    /// Named after the archive, and the folder inside it; its own folder in the models folder.
    pub folder: &'static str,
    pub kind: Kind,
    /// The model itself, in its folder.
    pub file: &'static str,
    /// The archive's size, roughly, until the download says.
    pub size: u64,
    /// The archive's SHA-256 once pinned (`cargo test -- --ignored prints_the_archives_to_pin`);
    /// until then the archive is trusted as served over HTTPS by the release.
    sha256: Option<&'static str>,
}

/// Every model on offer; the first is the default. The ids match `src/features/tts/models.ts`.
pub const MODELS: &[Model] = &[
    Model { id: "kokoro-en", folder: "kokoro-en-v0_19", kind: Kind::Kokoro, file: "model.onnx", size: 305_000_000, sha256: None },
    Model {
        id: "kitten-nano",
        folder: "kitten-nano-en-v0_1-fp16",
        kind: Kind::Kitten,
        file: "model.fp16.onnx",
        size: 25_000_000,
        sha256: None,
    },
    Model {
        id: "piper-en-lessac",
        folder: "vits-piper-en_US-lessac-medium",
        kind: Kind::Vits,
        file: "en_US-lessac-medium.onnx",
        size: 64_000_000,
        sha256: None,
    },
    Model {
        id: "piper-fr-siwis",
        folder: "vits-piper-fr_FR-siwis-medium",
        kind: Kind::Vits,
        file: "fr_FR-siwis-medium.onnx",
        size: 64_000_000,
        sha256: None,
    },
    Model {
        id: "piper-de-thorsten",
        folder: "vits-piper-de_DE-thorsten-medium",
        kind: Kind::Vits,
        file: "de_DE-thorsten-medium.onnx",
        size: 64_000_000,
        sha256: None,
    },
    Model {
        id: "piper-es-davefx",
        folder: "vits-piper-es_ES-davefx-medium",
        kind: Kind::Vits,
        file: "es_ES-davefx-medium.onnx",
        size: 64_000_000,
        sha256: None,
    },
];

/// The model with this id, or the default one.
pub fn find(id: Option<&str>) -> &'static Model {
    MODELS.iter().find(|m| Some(m.id) == id).unwrap_or(&MODELS[0])
}

impl Model {
    pub fn url(&self) -> String {
        format!("{RELEASE}/{}.tar.bz2", self.folder)
    }

    /// Ready once its model file and companions are there (archives are unpacked aside, then moved in whole).
    pub fn installed(&self, dir: &Path) -> bool {
        dir.join(self.file).is_file() && self.kind.companions().iter().all(|name| dir.join(name).exists())
    }

    pub fn status(&self, dir: &Path) -> Status {
        if self.installed(dir) { Status::Ready } else { Status::Missing { size: self.size } }
    }
}

/// The ids of the models already downloaded in the models folder `base`.
pub fn installed_in(base: &Path) -> Vec<&'static str> {
    MODELS.iter().filter(|m| m.installed(&base.join(m.folder))).map(|m| m.id).collect()
}

/// Downloads the model's archive into the models folder `base`, calling `progress(received, total)`
/// along the way, then unpacks it beside its folder and moves it in once complete.
pub fn download(model: &Model, base: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<(), DownloadError> {
    fs::create_dir_all(base)?;
    let archive = base.join(format!("{}.tar.bz2.part", model.folder));
    let staging = base.join(format!("{}.unpack", model.folder));
    let result = (|| {
        let mut out = io::BufWriter::new(File::create(&archive)?);
        let fetched = download::fetch(&model.url(), &mut out, cancel, |received| progress(received, model.size.max(received)))?;
        drop(out);
        if model.sha256.is_some_and(|sha| sha != fetched.sha256) {
            return Err(DownloadError::Corrupt(model.folder));
        }
        progress(fetched.size, fetched.size);
        unpack(&archive, &staging)?;
        let unpacked = staging.join(model.folder);
        if !model.installed(&unpacked) {
            return Err(DownloadError::Corrupt(model.folder));
        }
        let dir = base.join(model.folder);
        remove(&dir)?;
        fs::rename(&unpacked, &dir)?;
        Ok(())
    })();
    let _ = fs::remove_file(&archive);
    let _ = remove(&staging);
    result
}

/// Unpacks a `.tar.bz2` into `into`, which it empties first. Entries reaching outside are refused.
fn unpack(archive: &Path, into: &Path) -> io::Result<()> {
    remove(into)?;
    tar::Archive::new(BzDecoder::new(BufReader::new(File::open(archive)?))).unpack(into)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("island-tts-{name}-{}", std::process::id()));
        remove(&dir).unwrap();
        dir
    }

    /// A `.tar.bz2` holding `files` (path, contents).
    fn archive(path: &Path, files: &[(&str, &str)]) {
        let encoder = bzip2::write::BzEncoder::new(File::create(path).unwrap(), bzip2::Compression::fast());
        let mut tar = tar::Builder::new(encoder);
        for (name, body) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            tar.append_data(&mut header, name, body.as_bytes()).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn every_model_is_listed_once_with_its_archive() {
        let (mut ids, mut folders) = (std::collections::HashSet::new(), std::collections::HashSet::new());
        for m in MODELS {
            assert!(ids.insert(m.id) && folders.insert(m.folder), "{} is listed twice", m.id);
            assert!(m.file.ends_with(".onnx") && m.size > 0, "{}", m.id);
            assert!(m.sha256.is_none_or(|sha| sha.len() == 64), "{}", m.id);
        }
        assert_eq!(find(Some("piper-fr-siwis")).folder, "vits-piper-fr_FR-siwis-medium");
        assert_eq!(find(Some("gone")).id, "kokoro-en");
        assert_eq!(find(None).url(), "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2");
    }

    #[test]
    fn needs_the_model_and_its_companions() {
        let base = scratch("installed");
        let model = find(Some("kitten-nano"));
        let dir = base.join(model.folder);
        assert_eq!(model.status(&dir), Status::Missing { size: model.size });
        fs::create_dir_all(dir.join(ESPEAK)).unwrap();
        for name in [model.file, TOKENS] {
            fs::write(dir.join(name), "x").unwrap();
        }
        assert!(!model.installed(&dir), "voices.bin is missing");
        fs::write(dir.join(VOICES), "x").unwrap();
        assert_eq!(installed_in(&base), ["kitten-nano"]);
        remove(&base).unwrap();
    }

    #[test]
    fn unpacks_an_archive_aside() {
        let base = scratch("unpack");
        fs::create_dir_all(&base).unwrap();
        let path = base.join("voice.tar.bz2");
        archive(&path, &[("vits-piper-x/x.onnx", "model"), ("vits-piper-x/espeak-ng-data/phontab", "data")]);
        let into = base.join("staging");
        unpack(&path, &into).unwrap();
        assert_eq!(fs::read_to_string(into.join("vits-piper-x/espeak-ng-data/phontab")).unwrap(), "data");
        remove(&base).unwrap();
    }

    #[test]
    #[ignore = "downloads every archive, to pin their hashes"]
    fn prints_the_archives_to_pin() {
        for m in MODELS {
            let fetched = download::fetch(&m.url(), &mut io::sink(), &AtomicBool::new(false), |_| {}).unwrap();
            println!("{}: size {}, sha256 {}", m.id, fetched.size, fetched.sha256);
        }
    }
}
