//! AI providers, shared by every AI feature: online services (OpenAI, Groq, Mistral…) or the
//! user's own OpenAI-compatible server, each with its base URL and credentials (`auth.rs`).
//! They are listed in the settings' `providers`; a feature's "engine" option picks one of them, or
//! its own model on this machine, and its "remoteModel" (and "remoteVoice") the provider's model.

mod auth;
mod client;
mod wav;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{Wry, async_runtime::spawn_blocking, plugin::TauriPlugin};

pub use auth::Auth;

use crate::{Error, Res, shell::settings};

/// What one request to a text-to-speech endpoint reads at most: short enough to start soon,
/// and well under the usual limit (4096 characters).
const PIECE: usize = 600;

/// A provider, as Settings lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    /// What features' "engine" option stores.
    pub id: String,
    pub name: String,
    /// The OpenAI-compatible API's root, e.g. `https://api.openai.com/v1`.
    pub base_url: String,
    #[serde(default)]
    pub auth: Auth,
}

impl Provider {
    fn check(&self) -> Result<(), String> {
        let url = self.base_url.trim();
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(format!("{}: the address must start with https:// or http://", self.name));
        }
        Ok(())
    }
}

/// Every provider the settings list, skipping any that doesn't read.
pub fn all(settings: &Value) -> Vec<Provider> {
    let listed = settings.get("providers").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    listed.iter().filter_map(|p| Provider::deserialize(p).ok()).collect()
}

/// A provider's model, chosen for a feature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub provider: Provider,
    pub model: String,
    /// Text to speech's voice; none lets the provider choose.
    pub voice: Option<String>,
}

/// What a feature runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Engine {
    /// Its own model, on this machine.
    Local,
    Remote(Remote),
}

/// `feature`'s option `key`, trimmed; none when unset or blank.
fn text<'a>(settings: &'a Value, feature: &str, key: &str) -> Option<&'a str> {
    settings::option(settings, feature, key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// The provider `feature`'s "engine" option picks, none for its own engine; why it can't be used
/// when it is gone or misconfigured.
pub fn provider(settings: &Value, feature: &str) -> Result<Option<Provider>, String> {
    let Some(id) = text(settings, feature, "engine") else { return Ok(None) };
    let provider = all(settings)
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("The AI provider “{id}” is gone; choose another in Settings"))?;
    provider.check()?;
    Ok(Some(provider))
}

/// The engine `feature`'s options pick; why it can't run when they point at nothing usable.
pub fn chosen(settings: &Value, feature: &str) -> Result<Engine, String> {
    let text = |key| text(settings, feature, key);
    let Some(provider) = provider(settings, feature)? else { return Ok(Engine::Local) };
    let model = text("remoteModel").ok_or_else(|| format!("Choose the {} model to use in Settings", provider.name))?.to_string();
    Ok(Engine::Remote(Remote { provider, model, voice: text("remoteVoice").map(str::to_string) }))
}

/// `text` cut into pieces of at most about `max` bytes, at sentence ends (else at spaces).
pub fn pieces(text: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text.trim();
    while rest.len() > max {
        let mut window = max;
        while !rest.is_char_boundary(window) {
            window -= 1;
        }
        let head = &rest[..window];
        let cut = head
            .rfind(['.', '!', '?', '\n', '。'])
            .map(|i| i + head[i..].chars().next().map_or(1, char::len_utf8))
            .or_else(|| head.rfind(' '))
            .filter(|&i| i > 0)
            .unwrap_or(window);
        out.push(rest[..cut].trim());
        rest = rest[cut..].trim_start();
    }
    if !rest.is_empty() {
        out.push(rest);
    }
    out
}

impl Remote {
    /// What is said in `samples` (mono, at `rate`).
    pub fn transcribe(&self, samples: &[f32], rate: u32) -> Result<String, String> {
        client::transcribe(&self.provider, &self.model, &wav::encode(samples, rate))
    }

    /// Speaks `text` a piece at a time, handing each piece's audio (mono samples, rate) to
    /// `on_audio` as it arrives; stops early when that returns false.
    pub fn speak(&self, text: &str, speed: f32, mut on_audio: impl FnMut(&[f32], u32) -> bool) -> Result<(), String> {
        for piece in pieces(text, PIECE) {
            let audio = client::speech(&self.provider, &self.model, self.voice.as_deref(), piece, speed)?;
            let (samples, rate) = wav::decode(&audio)?;
            if !on_audio(&samples, rate) {
                break;
            }
        }
        Ok(())
    }
}

/// The models `provider` offers, by id: to check it is set up right, and to pick from.
#[tauri::command]
#[specta::specta]
async fn models(provider: Provider) -> Res<Vec<String>> {
    provider.check().map_err(Error::msg)?;
    spawn_blocking(move || client::models(&provider)).await.map_err(|_| Error::WorkerGone)?.map_err(Error::msg)
}

crate::ipc::providers!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|_| Ok(()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn settings(options: Value) -> Value {
        json!({
            "providers": [
                { "id": "openai", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1", "auth": { "kind": "env", "name": "OPENAI_API_KEY" } },
                { "id": "lab", "name": "Lab", "baseUrl": "http://10.0.0.2:8000/v1" },
                { "id": "ftp", "name": "Odd", "baseUrl": "ftp://x" },
                { "name": "no id" }
            ],
            "options": { "tts": options }
        })
    }

    #[test]
    fn lists_the_providers_that_read() {
        let ids: Vec<_> = all(&settings(json!({}))).into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["openai", "lab", "ftp"]);
        assert_eq!(all(&json!({ "providers": 3 })), []);
        assert_eq!(all(&Value::Null), []);
    }

    #[test]
    fn runs_locally_unless_a_provider_is_chosen() {
        assert_eq!(chosen(&settings(json!({})), "tts"), Ok(Engine::Local));
        assert_eq!(chosen(&settings(json!({ "engine": " " })), "tts"), Ok(Engine::Local));
    }

    #[test]
    fn picks_the_providers_model_and_voice() {
        let Ok(Engine::Remote(remote)) =
            chosen(&settings(json!({ "engine": "lab", "remoteModel": "kokoro", "remoteVoice": "af_bella" })), "tts")
        else {
            panic!("not remote")
        };
        assert_eq!((remote.provider.auth, remote.model.as_str(), remote.voice.as_deref()), (Auth::None, "kokoro", Some("af_bella")));
    }

    #[test]
    fn says_what_is_missing() {
        assert_eq!(
            chosen(&settings(json!({ "engine": "gone" })), "tts").unwrap_err(),
            "The AI provider “gone” is gone; choose another in Settings"
        );
        assert_eq!(chosen(&settings(json!({ "engine": "openai" })), "tts").unwrap_err(), "Choose the OpenAI model to use in Settings");
        assert!(chosen(&settings(json!({ "engine": "ftp", "remoteModel": "m" })), "tts").unwrap_err().contains("https://"));
    }

    #[test]
    fn finds_the_provider_alone_for_features_without_models() {
        assert_eq!(provider(&settings(json!({})), "tts"), Ok(None));
        assert_eq!(provider(&settings(json!({ "engine": "lab" })), "tts").unwrap().map(|p| p.id).as_deref(), Some("lab"));
        assert!(provider(&settings(json!({ "engine": "gone" })), "tts").is_err());
    }

    #[test]
    fn cuts_long_text_at_sentence_ends() {
        assert_eq!(pieces("  Short one.  ", 600), ["Short one."]);
        assert_eq!(pieces("One. Two! Three?", 10), ["One. Two!", "Three?"]);
        assert_eq!(pieces("aaaa bbbb cccc", 9), ["aaaa", "bbbb cccc"]);
        assert_eq!(pieces("abcdefghij", 4), ["abcd", "efgh", "ij"]);
        assert_eq!(pieces("éééé", 3), ["é", "é", "é", "é"], "never cuts inside a character");
        assert!(pieces("", 10).is_empty());
    }
}
