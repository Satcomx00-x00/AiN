//! The voice models the user can pick from, all run by sherpa-onnx. Each comes as one `.tar.bz2`
//! from sherpa-onnx's `tts-models` release (or from the models source: `<folder>.tar.bz2`, or the
//! `<folder>` unpacked), downloaded on request and unpacked into its own folder.

use std::{
    fs::{self, File},
    io::{self, BufReader},
    path::Path,
    sync::atomic::AtomicBool,
};

use bzip2::read::BzDecoder;

use crate::features::download::{DownloadError, Status, remove};
use crate::features::{download, models::Downloadable};

const RELEASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";
/// Every model reads its phonemes through espeak-ng, from this folder of its own.
const ESPEAK: &str = "espeak-ng-data";
const TOKENS: &str = "tokens.txt";
/// Kokoro's and Kitten's speakers.
const VOICES: &str = "voices.bin";
/// Multilingual Kokoro's English and Chinese pronunciations; other languages go through espeak-ng.
const LEXICON_EN: &str = "lexicon-us-en.txt";
const LEXICON_ZH: &str = "lexicon-zh.txt";
const DICT: &str = "dict";

/// How sherpa-onnx runs a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Piper voices: model, tokens; one speaker, or a few.
    Vits,
    /// model, voices, tokens.
    Kokoro,
    /// model, voices, tokens.
    Kitten,
    /// Multilingual Kokoro: model, voices, tokens, lexicons; speaks `lang` (an espeak-ng language).
    KokoroMulti { lang: &'static str },
}

impl Kind {
    /// The files and folders beside the model file.
    fn companions(self) -> &'static [&'static str] {
        match self {
            Self::Vits => &[TOKENS, ESPEAK],
            Self::Kokoro | Self::Kitten => &[VOICES, TOKENS, ESPEAK],
            Self::KokoroMulti { .. } => &[VOICES, TOKENS, ESPEAK, DICT, LEXICON_EN, LEXICON_ZH],
        }
    }
}

pub struct Model {
    /// What the "Voice model" setting stores.
    pub id: &'static str,
    /// Named after the archive, and the folder inside it; its own folder in the models folder.
    pub folder: &'static str,
    kind: Kind,
    /// The model itself, in its folder.
    pub file: &'static str,
    /// The archive's size, roughly, until the download says.
    pub size: u64,
    /// The one speaker it reads with, whatever the "voice" setting: a multilingual model's voice
    /// for its language.
    pub speaker: Option<i32>,
    /// The archive's SHA-256 once pinned (`cargo test -- --ignored prints_the_archives_to_pin`);
    /// until then the archive is trusted as served over HTTPS by the release.
    sha256: Option<&'static str>,
}

/// Every model on offer; the first is the default. The ids match `src/features/tts/models.ts`.
pub const MODELS: &[Model] = &[
    Model {
        id: "kokoro-en",
        folder: "kokoro-en-v0_19",
        kind: Kind::Kokoro,
        file: "model.onnx",
        size: 305_000_000,
        speaker: None,
        sha256: None,
    },
    Model {
        id: "kitten-nano",
        folder: "kitten-nano-en-v0_1-fp16",
        kind: Kind::Kitten,
        file: "model.fp16.onnx",
        size: 25_000_000,
        speaker: None,
        sha256: None,
    },
    Model {
        id: "piper-en-lessac",
        folder: "vits-piper-en_US-lessac-medium",
        kind: Kind::Vits,
        file: "en_US-lessac-medium.onnx",
        size: 64_000_000,
        speaker: None,
        sha256: None,
    },
    Model {
        id: "piper-fr-siwis",
        folder: "vits-piper-fr_FR-siwis-medium",
        kind: Kind::Vits,
        file: "fr_FR-siwis-medium.onnx",
        size: 64_000_000,
        speaker: None,
        sha256: None,
    },
    Model {
        id: "kokoro-fr",
        folder: "kokoro-multi-lang-v1_0",
        kind: Kind::KokoroMulti { lang: "fr" },
        file: "model.onnx",
        size: 350_000_000,
        // ff_siwis, Kokoro's French voice.
        speaker: Some(30),
        sha256: None,
    },
    Model {
        id: "piper-fr-upmc",
        folder: "vits-piper-fr_FR-upmc-medium",
        kind: Kind::Vits,
        file: "fr_FR-upmc-medium.onnx",
        size: 80_000_000,
        speaker: None,
        sha256: None,
    },
    Model {
        id: "piper-fr-tom",
        folder: "vits-piper-fr_FR-tom-medium",
        kind: Kind::Vits,
        file: "fr_FR-tom-medium.onnx",
        size: 67_000_000,
        speaker: None,
        sha256: None,
    },
    Model {
        id: "piper-de-thorsten",
        folder: "vits-piper-de_DE-thorsten-medium",
        kind: Kind::Vits,
        file: "de_DE-thorsten-medium.onnx",
        size: 64_000_000,
        speaker: None,
        sha256: None,
    },
    Model {
        id: "piper-es-davefx",
        folder: "vits-piper-es_ES-davefx-medium",
        kind: Kind::Vits,
        file: "es_ES-davefx-medium.onnx",
        size: 64_000_000,
        speaker: None,
        sha256: None,
    },
];

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

impl Model {
    /// How sherpa-onnx runs it from `dir`: its files, by kind.
    pub fn config(&self, dir: &Path) -> sherpa_onnx::OfflineTtsModelConfig {
        let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
        let mut config = sherpa_onnx::OfflineTtsModelConfig::default();
        match self.kind {
            Kind::Vits => {
                config.vits.model = path(self.file);
                config.vits.tokens = path(TOKENS);
                config.vits.data_dir = path(ESPEAK);
            }
            Kind::Kokoro => {
                config.kokoro.model = path(self.file);
                config.kokoro.voices = path(VOICES);
                config.kokoro.tokens = path(TOKENS);
                config.kokoro.data_dir = path(ESPEAK);
            }
            Kind::KokoroMulti { lang } => {
                config.kokoro.model = path(self.file);
                config.kokoro.voices = path(VOICES);
                config.kokoro.tokens = path(TOKENS);
                config.kokoro.data_dir = path(ESPEAK);
                config.kokoro.dict_dir = path(DICT);
                config.kokoro.lexicon = path(LEXICON_EN).zip(path(LEXICON_ZH)).map(|(en, zh)| format!("{en},{zh}"));
                config.kokoro.lang = Some(lang.into());
            }
            Kind::Kitten => {
                config.kitten.model = path(self.file);
                config.kitten.voices = path(VOICES);
                config.kitten.tokens = path(TOKENS);
                config.kitten.data_dir = path(ESPEAK);
            }
        }
        config
    }
}

impl Downloadable for Model {
    fn id(&self) -> &'static str {
        self.id
    }

    fn folder(&self) -> &'static str {
        self.folder
    }

    fn status(&self, dir: &Path) -> Status {
        Model::status(self, dir)
    }

    fn size(&self) -> u64 {
        self.size
    }

    fn download(&self, base: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<(), DownloadError> {
        download(self, base, cancel, progress)
    }
}

/// Downloads the model's archive into the models folder `base`, calling `progress(received, total)`
/// along the way, then unpacks it beside its folder and moves it in once complete.
fn download(model: &Model, base: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<(), DownloadError> {
    fs::create_dir_all(base)?;
    let archive = base.join(format!("{}.tar.bz2.part", model.folder));
    let staging = base.join(format!("{}.unpack", model.folder));
    let result = (|| {
        // A local models source may hold the voice unpacked, as in a models folder.
        if let Some(from) = download::local_folder(model.folder).filter(|d| model.installed(d)) {
            progress(0, model.size);
            remove(&staging)?;
            download::copy_dir(&from, &staging.join(model.folder))?;
            return install(model, base, &staging);
        }
        let mut out = io::BufWriter::new(File::create(&archive)?);
        let url = download::source(model.url(), &format!("{}.tar.bz2", model.folder));
        let fetched = download::fetch(&url, &mut out, cancel, |received| progress(received, model.size.max(received)))?;
        drop(out);
        if model.sha256.is_some_and(|sha| sha != fetched.sha256) {
            return Err(DownloadError::Corrupt(model.folder));
        }
        progress(fetched.size, fetched.size);
        unpack(&archive, &staging)?;
        install(model, base, &staging)
    })();
    let _ = fs::remove_file(&archive);
    let _ = remove(&staging);
    result
}

/// Moves the voice unpacked in `staging` into the models folder `base`, once it is complete.
fn install(model: &Model, base: &Path, staging: &Path) -> Result<(), DownloadError> {
    let unpacked = staging.join(model.folder);
    if !model.installed(&unpacked) {
        return Err(DownloadError::Corrupt(model.folder));
    }
    let dir = base.join(model.folder);
    remove(&dir)?;
    fs::rename(&unpacked, &dir)?;
    Ok(())
}

/// Unpacks a `.tar.bz2` into `into`, which it empties first. Entries reaching outside are refused.
fn unpack(archive: &Path, into: &Path) -> io::Result<()> {
    remove(into)?;
    tar::Archive::new(BzDecoder::new(BufReader::new(File::open(archive)?))).unpack(into)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(id: Option<&str>) -> &'static Model {
        crate::features::models::find(MODELS, id)
    }

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
        assert!(model.installed(&dir));
        remove(&base).unwrap();
    }

    #[test]
    fn the_french_kokoro_speaks_french_with_its_french_voice() {
        let model = find(Some("kokoro-fr"));
        let config = model.config(Path::new("kokoro"));
        assert_eq!((model.speaker, config.kokoro.lang.as_deref()), (Some(30), Some("fr")));
        assert!(config.kokoro.lexicon.is_some_and(|l| l.contains(LEXICON_EN) && l.contains(LEXICON_ZH)));
        assert!(model.kind.companions().contains(&DICT));
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
    #[ignore = "reads French with each French model downloaded in $TTS_MODELS"]
    fn smoke_reads_french() {
        let base = std::path::PathBuf::from(std::env::var("TTS_MODELS").expect("TTS_MODELS: a models folder"));
        for m in MODELS.iter().filter(|m| m.id.contains("-fr")) {
            let dir = base.join(m.folder);
            if !m.installed(&dir) {
                continue;
            }
            let tts = super::super::engine::load(m, &dir).unwrap();
            let config = sherpa_onnx::GenerationConfig { sid: m.speaker.unwrap_or(0), ..Default::default() };
            let audio =
                tts.generate_with_config("Bonjour, ceci est un essai de lecture à voix haute.", &config, None::<fn(&[f32], f32) -> bool>);
            let seconds = audio.map_or(0.0, |a| a.samples().len() as f32 / a.sample_rate() as f32);
            println!("{}: {seconds:.1} s", m.id);
            assert!(seconds > 1.0, "{} read nothing", m.id);
        }
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
