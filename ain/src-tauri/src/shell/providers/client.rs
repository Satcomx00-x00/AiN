//! The OpenAI-compatible HTTP API every provider speaks: its models, speech to text
//! (`/audio/transcriptions`) and text to speech (`/audio/speech`).

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use super::Provider;

/// Audio and model lists, not files.
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(120);

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(TIMEOUT)).build().into()
}

/// `base` and `path` joined by one slash.
pub fn endpoint(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim().trim_end_matches('/'), path.trim_start_matches('/'))
}

/// The provider's own words for a refusal, when it gives them (`{"error": {"message": …}}`).
fn refusal(status: u16, body: &str) -> String {
    let said = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| {
        let error = v.get("error")?;
        error.get("message").or(Some(error)).and_then(|m| m.as_str().map(str::to_string))
    });
    match (status, said) {
        (401 | 403, _) => format!("The provider refused the token ({status})"),
        (_, Some(said)) => format!("The provider answered {status}: {said}"),
        _ => format!("The provider answered {status}"),
    }
}

/// Sends `body` (of type `content_type`) to `path`, or GETs it when there is none; the response's bytes.
fn call(provider: &Provider, path: &str, body: Option<(&str, &[u8])>) -> Result<Vec<u8>, String> {
    let url = endpoint(&provider.base_url, path);
    let token = provider.auth.token()?;
    let bearer = token.map(|t| format!("Bearer {t}"));
    let sent = match body {
        Some((kind, bytes)) => {
            let request = agent().post(&url).header("Content-Type", kind);
            match &bearer {
                Some(b) => request.header("Authorization", b).send(bytes),
                None => request.send(bytes),
            }
        }
        None => {
            let request = agent().get(&url);
            match &bearer {
                Some(b) => request.header("Authorization", b).call(),
                None => request.call(),
            }
        }
    };
    let mut response = sent.map_err(|e| format!("Couldn't reach {url}: {e}"))?;
    let status = response.status().as_u16();
    let bytes = response.body_mut().with_config().limit(MAX_BYTES).read_to_vec().map_err(|e| format!("Couldn't read {url}: {e}"))?;
    if (200..300).contains(&status) { Ok(bytes) } else { Err(refusal(status, &String::from_utf8_lossy(&bytes))) }
}

#[derive(Deserialize)]
struct Listed {
    data: Vec<Model>,
}

#[derive(Deserialize)]
struct Model {
    id: String,
}

/// The ids of the models the provider offers, sorted.
pub fn models(provider: &Provider) -> Result<Vec<String>, String> {
    let bytes = call(provider, "models", None)?;
    let listed: Listed = serde_json::from_slice(&bytes).map_err(|_| "The provider didn't list its models".to_string())?;
    let mut ids: Vec<_> = listed.data.into_iter().map(|m| m.id).collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// A `multipart/form-data` body of text fields and one file, and its content type.
fn multipart(fields: &[(&str, &str)], file: (&str, &str, &[u8])) -> Result<(String, Vec<u8>), String> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|e| format!("no randomness: {e}"))?;
    let boundary = nonce.iter().fold("ain-".to_string(), |s, b| s + &format!("{b:02x}"));
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    let (name, filename, bytes) = file;
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), body))
}

#[derive(Deserialize)]
struct Transcript {
    text: String,
}

/// What `model` hears in `wav`.
pub fn transcribe(provider: &Provider, model: &str, wav: &[u8]) -> Result<String, String> {
    let (kind, body) = multipart(&[("model", model), ("response_format", "json")], ("file", "speech.wav", wav))?;
    let bytes = call(provider, "audio/transcriptions", Some((&kind, &body)))?;
    let transcript: Transcript = serde_json::from_slice(&bytes).map_err(|_| "The provider sent no transcript".to_string())?;
    Ok(transcript.text.trim().to_string())
}

/// `text` spoken by `model` (in `voice`, when given), as WAV.
pub fn speech(provider: &Provider, model: &str, voice: Option<&str>, text: &str, speed: f32) -> Result<Vec<u8>, String> {
    let mut request = json!({ "model": model, "input": text, "speed": speed, "response_format": "wav" });
    if let Some(voice) = voice {
        request["voice"] = json!(voice);
    }
    call(provider, "audio/speech", Some(("application/json", &serde_json::to_vec(&request).map_err(|e| e.to_string())?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_the_base_url_and_the_path() {
        assert_eq!(endpoint("https://api.openai.com/v1/", "/models"), "https://api.openai.com/v1/models");
        assert_eq!(endpoint(" http://localhost:8000/v1 ", "audio/speech"), "http://localhost:8000/v1/audio/speech");
    }

    #[test]
    fn says_why_a_provider_refused() {
        assert_eq!(refusal(401, ""), "The provider refused the token (401)");
        assert_eq!(refusal(400, r#"{"error":{"message":"bad model"}}"#), "The provider answered 400: bad model");
        assert_eq!(refusal(422, r#"{"error":"nope"}"#), "The provider answered 422: nope");
        assert_eq!(refusal(500, "<html>"), "The provider answered 500");
    }

    #[test]
    fn writes_a_form_with_its_fields_and_file() {
        let (kind, body) = multipart(&[("model", "whisper-1")], ("file", "speech.wav", b"RIFF")).unwrap();
        let boundary = kind.strip_prefix("multipart/form-data; boundary=").unwrap();
        let body = String::from_utf8(body).unwrap();
        assert!(body.starts_with(&format!("--{boundary}\r\n")));
        assert!(body.contains("name=\"model\"\r\n\r\nwhisper-1\r\n"));
        assert!(body.contains("filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n"));
        assert!(body.ends_with(&format!("--{boundary}--\r\n")));
    }

    /// One HTTP exchange on a local port: answers `reply` and hands back what was asked.
    fn serve_once(reply: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let served = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
            let mut asked = Vec::new();
            let mut buf = [0; 4096];
            while let Ok(n @ 1..) = socket.read(&mut buf) {
                asked.extend_from_slice(&buf[..n]);
            }
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{reply}", reply.len());
            socket.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&asked).into_owned()
        });
        (base, served)
    }

    #[test]
    fn lists_models_with_the_bearer_token() {
        let (base, served) = serve_once(r#"{"data":[{"id":"whisper-1"},{"id":"tts-1"}]}"#);
        let provider =
            Provider { id: "local".into(), name: "Local".into(), base_url: base, auth: super::super::Auth::Env { name: "PATH".into() } };
        assert_eq!(models(&provider).unwrap(), ["tts-1", "whisper-1"]);
        let asked = served.join().unwrap();
        assert!(asked.starts_with("GET /v1/models "), "{asked}");
        assert!(asked.to_ascii_lowercase().contains("authorization: bearer "), "{asked}");
    }

    #[test]
    fn transcribes_without_auth() {
        let (base, served) = serve_once(r#"{"text":" hello there "}"#);
        let provider = Provider { id: "local".into(), name: "Local".into(), base_url: base, auth: super::super::Auth::None };
        assert_eq!(transcribe(&provider, "whisper-1", b"RIFF").unwrap(), "hello there");
        let asked = served.join().unwrap();
        assert!(asked.starts_with("POST /v1/audio/transcriptions "), "{asked}");
        assert!(!asked.to_ascii_lowercase().contains("authorization"), "{asked}");
    }
}
