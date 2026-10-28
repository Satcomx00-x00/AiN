//! Every address and folder the app has built in, each overridable by an `AIN_*` environment
//! variable: a mirror, a fork's store, a local server for tests, a portable install. The full list,
//! with defaults, is in docs/configuration.md; a test keeps it complete.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

/// A built-in value and the environment variable that overrides it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Var {
    pub name: &'static str,
    /// What's used when the variable is unset or blank; empty when derived elsewhere (see its docs).
    pub default: &'static str,
}

impl Var {
    const fn new(name: &'static str, default: &'static str) -> Self {
        Self { name, default }
    }

    /// The variable's value, trimmed, when it is set and not blank.
    pub fn set(self) -> Option<String> {
        self.from(|name| std::env::var(name).ok())
    }

    /// The override, or the default.
    pub fn get(self) -> String {
        self.set().unwrap_or_else(|| self.default.into())
    }

    fn from(self, lookup: impl FnOnce(&str) -> Option<String>) -> Option<String> {
        lookup(self.name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
    }
}

/// `store.yaml`, the community plugin store's catalog.
pub const STORE_URL: Var = Var::new("AIN_STORE_URL", "https://raw.githubusercontent.com/Satcomx00-x00/AiN/store/store.yaml");
/// Where store plugins' files are downloaded from: `{base}/{owner}/{repo}/{ref}/{entry}`.
pub const GITHUB_RAW_URL: Var = Var::new("AIN_GITHUB_RAW_URL", "https://raw.githubusercontent.com");
/// GitHub itself, for the releases page and their `latest.json`.
pub const GITHUB_URL: Var = Var::new("AIN_GITHUB_URL", "https://github.com");
/// The repository (`owner/name`) whose releases the updater follows.
pub const REPO: Var = Var::new("AIN_REPO", "Satcomx00-x00/AiN");
/// `latest.json`; derived from [`GITHUB_URL`] and [`REPO`] by default (see docs/updates.md).
pub const UPDATE_URL: Var = Var::new("AIN_UPDATE_URL", "");
/// Hugging Face: dictation's models, and PersonaPlex's (passed on as `HF_ENDPOINT`).
pub const HF_URL: Var = Var::new("AIN_HF_URL", "https://huggingface.co");
/// The sherpa-onnx release holding the read-aloud voices: `{base}/{model}.tar.bz2`.
pub const TTS_MODELS_URL: Var = Var::new("AIN_TTS_MODELS_URL", "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models");
/// PyTorch's package index for PersonaPlex; CUDA 12.4's by default, PyPI's on macOS.
pub const TORCH_INDEX_URL: Var = Var::new("AIN_TORCH_INDEX_URL", "https://download.pytorch.org/whl/cu124");
/// The AI provider presets' addresses, as Settings fills them in.
pub const OPENAI_URL: Var = Var::new("AIN_PROVIDER_OPENAI_URL", "https://api.openai.com/v1");
pub const GROQ_URL: Var = Var::new("AIN_PROVIDER_GROQ_URL", "https://api.groq.com/openai/v1");
pub const MISTRAL_URL: Var = Var::new("AIN_PROVIDER_MISTRAL_URL", "https://api.mistral.ai/v1");
pub const CUSTOM_URL: Var = Var::new("AIN_PROVIDER_CUSTOM_URL", "http://localhost:8000/v1");
/// The settings file and plugins folder; the OS's app config folder by default.
pub const CONFIG_DIR: Var = Var::new("AIN_CONFIG_DIR", "");
/// The downloaded models (under `models/`); the OS's app data folder by default.
pub const DATA_DIR: Var = Var::new("AIN_DATA_DIR", "");
/// Turns certificate checks off when `1`, `true`, `yes` or `on`, whatever the settings say (see docs/offline.md).
pub const INSECURE_TLS: Var = Var::new("AIN_INSECURE_TLS", "");
/// A folder or URL laid out like the models folder, used instead of the internet; wins over the settings' one.
pub const MODELS_SOURCE: Var = Var::new("AIN_MODELS_SOURCE", "");

/// Every variable, for the tests.
#[cfg(test)]
const ALL: &[Var] = &[
    STORE_URL,
    GITHUB_RAW_URL,
    GITHUB_URL,
    REPO,
    UPDATE_URL,
    HF_URL,
    TTS_MODELS_URL,
    TORCH_INDEX_URL,
    OPENAI_URL,
    GROQ_URL,
    MISTRAL_URL,
    CUSTOM_URL,
    CONFIG_DIR,
    DATA_DIR,
    INSECURE_TLS,
    MODELS_SOURCE,
];

/// An address without its trailing `/`, to join paths onto.
pub fn base(var: Var) -> String {
    var.get().trim_end_matches('/').into()
}

/// Where the settings file and plugins folder are.
pub fn config_dir<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PathBuf> {
    CONFIG_DIR.set().map_or_else(|| app.path().app_config_dir(), |d| Ok(d.into()))
}

/// Where downloaded models are kept, under `models/`.
pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PathBuf> {
    DATA_DIR.set().map_or_else(|| app.path().app_data_dir(), |d| Ok(d.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_variable_keeps_the_default() {
        assert_eq!(STORE_URL.from(|_| None), None);
        assert_eq!(STORE_URL.from(|_| Some("  ".into())), None);
        assert_eq!(STORE_URL.from(|n| Some(format!(" https://mirror/{n} "))).as_deref(), Some("https://mirror/AIN_STORE_URL"));
    }

    #[test]
    fn names_are_unique_and_prefixed() {
        let mut seen = std::collections::HashSet::new();
        for v in ALL {
            assert!(v.name.starts_with("AIN_") && seen.insert(v.name), "{}", v.name);
        }
    }

    #[test]
    fn every_variable_is_documented() {
        let docs = include_str!("../../../docs/configuration.md");
        for v in ALL {
            assert!(docs.contains(&format!("`{}`", v.name)), "{} is missing from docs/configuration.md", v.name);
        }
    }
}
