//! The speech models the user can pick from, all run by sherpa-onnx. Each is downloaded on request
//! from Hugging Face at a pinned revision (or from the models source, as `<folder>/<file>`), checked
//! against known hashes, into its own folder.

use std::{
    fs::{self, File},
    io,
    path::Path,
    sync::atomic::AtomicBool,
};

#[cfg(test)]
use crate::features::download::remove;
pub use crate::features::download::{DownloadError, Status};
use crate::features::{download, models::Downloadable};

pub struct ModelFile {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

const fn file(name: &'static str, size: u64, sha256: &'static str) -> ModelFile {
    ModelFile { name, size, sha256 }
}

/// How sherpa-onnx runs a model; its files are listed in the order the kind expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// encoder, decoder, joiner, tokens.
    Transducer,
    /// encoder, decoder, tokens.
    Whisper,
    /// model, tokens.
    SenseVoice,
    /// preprocessor, encoder, uncached decoder, cached decoder, tokens.
    Moonshine,
}

pub struct Model {
    /// What the "Speech model" setting stores.
    pub id: &'static str,
    /// Its own folder, inside the models folder.
    pub folder: &'static str,
    repo: &'static str,
    revision: &'static str,
    pub kind: Kind,
    pub files: &'static [ModelFile],
    /// Whisper and Moonshine hear at most 30 s at once; long dictations are cut in pieces this long.
    pub chunk_seconds: f32,
}

const WHISPER_TOKENS: &str = "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126";

/// Every model on offer; the first is the default. The ids match `src/plugins/dictation/models.ts`.
pub const MODELS: &[Model] = &[
    Model {
        id: "parakeet-v3",
        folder: "parakeet-tdt-0.6b-v3-int8",
        repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        revision: "2bda32ec70b097a55adaa07d9a7173915b43cc78",
        kind: Kind::Transducer,
        files: &[
            file("encoder.int8.onnx", 652_184_281, "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"),
            file("decoder.int8.onnx", 11_845_275, "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"),
            file("joiner.int8.onnx", 6_355_277, "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"),
            file("tokens.txt", 93_939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
        ],
        chunk_seconds: 30.0,
    },
    Model {
        id: "parakeet-v2",
        folder: "parakeet-tdt-0.6b-v2-int8",
        repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        revision: "1ab9323565ddb038682214b292f588070a538ce2",
        kind: Kind::Transducer,
        files: &[
            file("encoder.int8.onnx", 652_184_296, "a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab"),
            file("decoder.int8.onnx", 7_257_753, "b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e"),
            file("joiner.int8.onnx", 1_739_080, "7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2"),
            file("tokens.txt", 9_384, "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d"),
        ],
        chunk_seconds: 30.0,
    },
    Model {
        id: "whisper-turbo",
        folder: "whisper-large-v3-turbo-int8",
        repo: "csukuangfj/sherpa-onnx-whisper-turbo",
        revision: "2ca6ff69fc878651b770880507669577ac41c2ff",
        kind: Kind::Whisper,
        files: &[
            file("turbo-encoder.int8.onnx", 674_716_297, "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b"),
            file("turbo-decoder.int8.onnx", 361_080_764, "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547"),
            file("turbo-tokens.txt", 816_730, WHISPER_TOKENS),
        ],
        chunk_seconds: 28.0,
    },
    Model {
        id: "whisper-small",
        folder: "whisper-small-int8",
        repo: "csukuangfj/sherpa-onnx-whisper-small",
        revision: "8f3c18b358db4d1f2fc1eae49d75cd20989e4309",
        kind: Kind::Whisper,
        files: &[
            file("small-encoder.int8.onnx", 112_442_483, "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9"),
            file("small-decoder.int8.onnx", 262_226_114, "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee"),
            file("small-tokens.txt", 816_730, WHISPER_TOKENS),
        ],
        chunk_seconds: 28.0,
    },
    Model {
        id: "whisper-base",
        folder: "whisper-base-int8",
        repo: "csukuangfj/sherpa-onnx-whisper-base",
        revision: "bb53ee204431c90d314c1cc08d28d23e5b7927cc",
        kind: Kind::Whisper,
        files: &[
            file("base-encoder.int8.onnx", 29_120_534, "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11"),
            file("base-decoder.int8.onnx", 130_672_026, "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d"),
            file("base-tokens.txt", 816_730, WHISPER_TOKENS),
        ],
        chunk_seconds: 28.0,
    },
    Model {
        id: "sense-voice",
        folder: "sense-voice-2024-07-17-int8",
        repo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
        revision: "2365baeacb507f821a0c8120fcee3d484dba7a07",
        kind: Kind::SenseVoice,
        files: &[
            file("model.int8.onnx", 239_233_841, "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"),
            file("tokens.txt", 315_894, "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"),
        ],
        chunk_seconds: 30.0,
    },
    Model {
        id: "moonshine-base",
        folder: "moonshine-base-en-int8",
        repo: "csukuangfj/sherpa-onnx-moonshine-base-en-int8",
        revision: "052b0798ad1bf046a140fdd4efcd9426530fa3f5",
        kind: Kind::Moonshine,
        files: &[
            file("preprocess.onnx", 14_077_290, "ffa630d395c5ccf76f5d4954be5b882df76aaf6491519ec01fd82ea7a3819fb2"),
            file("encode.int8.onnx", 50_311_494, "7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2"),
            file("uncached_decode.int8.onnx", 122_120_451, "c01f4b35093bcac20d352d23a75a539e772964579f9d024a90e5e6f09cae9987"),
            file("cached_decode.int8.onnx", 99_983_837, "2db74e51cedf64a8b1be3c8192e0bb5e4923af0e90bd9e87f8e8771873f8ea03"),
            file("tokens.txt", 436_688, "1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea"),
        ],
        chunk_seconds: 20.0,
    },
];

impl Model {
    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    pub fn url(&self, file: &str) -> String {
        format!("{}/{}/resolve/{}/{file}?download=true", crate::config::base(crate::config::HF_URL), self.repo, self.revision)
    }

    /// Ready once every file is there at its full size (hashes were checked when it was downloaded).
    pub fn installed(&self, dir: &Path) -> bool {
        self.files.iter().all(|f| fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.size))
    }

    pub fn status(&self, dir: &Path) -> Status {
        if self.installed(dir) { Status::Ready } else { Status::Missing { size: self.total_size() } }
    }

    /// The path of its `i`th file in `dir`.
    pub fn path(&self, dir: &Path, i: usize) -> String {
        dir.join(self.files[i].name).to_string_lossy().into_owned()
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
        self.total_size()
    }

    fn download(&self, base: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<(), DownloadError> {
        download(self, &base.join(self.folder), cancel, progress)
    }
}

/// Downloads the model's missing files into `dir`, calling `progress(received, total)` along the way.
/// Each file streams into `<name>.part`, is hashed on the fly, and is renamed only if it matches.
fn download(model: &Model, dir: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<(), DownloadError> {
    fs::create_dir_all(dir)?;
    let total = model.total_size();
    let mut done = 0;
    for file in model.files {
        let path = dir.join(file.name);
        if fs::metadata(&path).is_ok_and(|m| m.len() == file.size) {
            done += file.size;
            continue;
        }
        let part = dir.join(format!("{}.part", file.name));
        let result = (|| {
            let mut out = io::BufWriter::new(File::create(&part)?);
            let url = download::source(model.url(file.name), &format!("{}/{}", model.folder, file.name));
            let fetched = download::fetch(&url, &mut out, cancel, |received| progress(done + received, total))?;
            drop(out);
            if fetched.size != file.size || fetched.sha256 != file.sha256 {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn find(id: Option<&str>) -> &'static Model {
        crate::features::models::find(MODELS, id)
    }

    #[test]
    fn pins_the_revision() {
        let parakeet = find(None);
        assert_eq!(
            parakeet.url("tokens.txt"),
            "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/tokens.txt?download=true"
        );
        assert_eq!(parakeet.total_size(), 670_478_772);
    }

    #[test]
    fn every_model_is_complete_for_its_kind() {
        let mut ids = std::collections::HashSet::new();
        let mut folders = std::collections::HashSet::new();
        for m in MODELS {
            assert!(ids.insert(m.id) && folders.insert(m.folder), "{} is listed twice", m.id);
            let expected = match m.kind {
                Kind::Transducer => 4,
                Kind::Whisper => 3,
                Kind::SenseVoice => 2,
                Kind::Moonshine => 5,
            };
            assert_eq!(m.files.len(), expected, "{}", m.id);
            assert!(m.files.last().is_some_and(|f| f.name.ends_with("tokens.txt")), "{} ends with its tokens", m.id);
            assert!(m.files.iter().all(|f| f.sha256.len() == 64 && f.size > 0), "{}", m.id);
            assert!(m.chunk_seconds <= 30.0);
        }
        assert_eq!(find(Some("whisper-small")).id, "whisper-small");
        assert_eq!(find(Some("gone")).id, "parakeet-v3");
    }

    #[test]
    fn missing_until_every_file_is_complete() {
        let base = std::env::temp_dir().join(format!("island-model-test-{}", std::process::id()));
        let model = find(Some("sense-voice"));
        let dir = base.join(model.folder);
        let _ = remove(&base);
        assert_eq!(model.status(&dir), Status::Missing { size: model.total_size() });
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("tokens.txt"), "partial").unwrap();
        assert!(!model.installed(&dir));
        assert!(crate::features::models::installed_in(MODELS, &base).is_empty());
        remove(&base).unwrap();
        remove(&base).unwrap();
    }
}
