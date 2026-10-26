//! A provider's credentials: none, or a bearer token (a JWT or an API key) read from an
//! environment variable or a file. It is read again for every request, so a token that is
//! rotated (a file a sidecar refreshes, say) is picked up without restarting.

use std::{
    fs::File,
    io::Read,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use specta::Type;

/// A token, not a document.
const MAX_LEN: u64 = 16 * 1024;

/// How requests to a provider authenticate.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Auth {
    /// An open endpoint, e.g. a model server on this machine.
    #[default]
    None,
    /// A bearer token in this environment variable.
    Env { name: String },
    /// A bearer token in this file (its whole content, trimmed).
    File { path: String },
}

impl Auth {
    /// The token to send as `Authorization: Bearer …`, read now; none for an open endpoint.
    pub fn token(&self) -> Result<Option<String>, String> {
        let raw = match self {
            Self::None => return Ok(None),
            Self::Env { name } => std::env::var(name).map_err(|_| format!("The environment variable {name} isn't set"))?,
            Self::File { path } => read(path)?,
        };
        check(&raw, now()).map(Some)
    }
}

fn read(path: &str) -> Result<String, String> {
    let mut text = String::new();
    File::open(path)
        .and_then(|f| f.take(MAX_LEN).read_to_string(&mut text))
        .map_err(|e| format!("Couldn't read the token file {path}: {e}"))?;
    Ok(text)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The token without whitespace or a pasted `Bearer ` prefix; refused when empty, or a JWT past its expiry.
fn check(raw: &str, now: u64) -> Result<String, String> {
    let token = raw.trim();
    let token = token.strip_prefix("Bearer ").unwrap_or(token).trim();
    if token.is_empty() {
        return Err("The token is empty".into());
    }
    if token.chars().any(char::is_control) {
        return Err("The token holds line breaks or control characters".into());
    }
    match expiry(token) {
        Some(exp) if exp <= now => Err("The token (JWT) has expired".into()),
        _ => Ok(token.to_string()),
    }
}

/// A JWT's `exp` claim, in seconds since the epoch; none for any other token.
fn expiry(token: &str) -> Option<u64> {
    let [_, claims, _] = token.split('.').collect::<Vec<_>>()[..] else { return None };
    let json = URL_SAFE_NO_PAD.decode(claims.trim_end_matches('=')).ok()?;
    serde_json::from_slice::<serde_json::Value>(&json).ok()?.get("exp")?.as_u64()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: &str) -> String {
        format!("eyJhbGciOiJIUzI1NiJ9.{}.sig", URL_SAFE_NO_PAD.encode(claims))
    }

    #[test]
    fn trims_tokens_and_drops_a_pasted_bearer_prefix() {
        assert_eq!(check("  sk-abc\n", 0).unwrap(), "sk-abc");
        assert_eq!(check("Bearer sk-abc", 0).unwrap(), "sk-abc");
        assert!(check(" \n", 0).is_err());
        assert!(check("a\u{7}b", 0).is_err());
    }

    #[test]
    fn refuses_an_expired_jwt_only() {
        let token = jwt(r#"{"sub":"me","exp":1000}"#);
        assert_eq!(check(&token, 999).unwrap(), token);
        assert_eq!(check(&token, 1000).unwrap_err(), "The token (JWT) has expired");
        assert!(check(&jwt(r#"{"sub":"me"}"#), u64::MAX).is_ok(), "no exp: never expires");
        assert_eq!(expiry("not.a.jwt!"), None);
        assert_eq!(expiry("sk-abc"), None);
    }

    #[test]
    fn reads_the_token_from_a_file_or_a_variable() {
        let path = std::env::temp_dir().join(format!("ain-token-{}", std::process::id()));
        std::fs::write(&path, "tok-from-file\n").unwrap();
        let file = Auth::File { path: path.to_string_lossy().into_owned() };
        assert_eq!(file.token().unwrap().as_deref(), Some("tok-from-file"));
        std::fs::remove_file(&path).unwrap();
        assert!(file.token().unwrap_err().starts_with("Couldn't read the token file"));
        let missing = Auth::Env { name: "AIN_TEST_SURELY_UNSET_TOKEN".into() };
        assert_eq!(missing.token().unwrap_err(), "The environment variable AIN_TEST_SURELY_UNSET_TOKEN isn't set");
        let path = Auth::Env { name: "PATH".into() };
        assert!(path.token().unwrap().is_some());
        assert_eq!(Auth::None.token().unwrap(), None);
    }

    #[test]
    fn reads_the_settings_shape() {
        let auth: Auth = serde_json::from_value(serde_json::json!({ "kind": "env", "name": "OPENAI_API_KEY" })).unwrap();
        assert_eq!(auth, Auth::Env { name: "OPENAI_API_KEY".into() });
        let auth: Auth = serde_json::from_value(serde_json::json!({ "kind": "none" })).unwrap();
        assert_eq!(auth, Auth::None);
    }
}
