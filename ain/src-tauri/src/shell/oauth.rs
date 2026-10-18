//! Signing plugins in to online accounts, with OAuth 2.0 for native apps (RFC 8252, with PKCE):
//! the system browser shows the provider's sign-in page and sends the user back to a one-off
//! loopback address the app listens on. The refresh token stays in the OS keychain; plugins only
//! ever get short-lived access tokens. Each plugin brings its provider's addresses and its own
//! client, so the app holds no account of its own.
//!
//! Accounts are filed by the plugin id the island passes. Every plugin runs in the island's one
//! window, so this keeps well-behaved plugins apart rather than guarding against a malicious one,
//! which could pass another's id, or read its tokens from `fetch`: plugins are trusted code.

use std::{
    collections::{BTreeMap, HashMap},
    io::{BufRead, BufReader, ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::{Wry, async_runtime::spawn_blocking, plugin::TauriPlugin};

use crate::{Error, Res};

/// How long the browser has to come back once the sign-in page is open.
const TIMEOUT: Duration = Duration::from_secs(180);
/// An access token this close to expiring is refreshed rather than handed out.
const MARGIN: Duration = Duration::from_secs(60);
/// Token responses are small JSON objects.
const MAX_BYTES: u64 = 64 * 1024;
/// The keychain entries' service name.
const SERVICE: &str = "dev.satcom.ain";

/// Where and as whom a plugin signs in: its provider's addresses and the client it registered there.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    /// The sign-in page, e.g. "https://accounts.google.com/o/oauth2/v2/auth".
    pub auth_url: String,
    /// Where codes and refresh tokens are exchanged for access tokens.
    pub token_url: String,
    /// Where a refresh token is revoked on sign-out, if the provider has one.
    #[serde(default)]
    pub revoke_url: Option<String>,
    pub client_id: String,
    /// Native apps can't keep a secret, but some providers (Google) still ask for one.
    #[serde(default)]
    pub client_secret: Option<String>,
    pub scopes: Vec<String>,
    /// Extra parameters for the sign-in page, e.g. `access_type: offline` for Google.
    #[serde(default)]
    pub params: BTreeMap<String, String>,
}

/// Same rule as a plugin's id.
fn valid_id(id: &str) -> bool {
    (2..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// HTTPS, or plain HTTP to this machine (a provider run locally, in development or tests).
fn secure(url: &str) -> bool {
    let loopback = ["http://127.0.0.1:", "http://127.0.0.1/", "http://localhost:", "http://localhost/"];
    url.starts_with("https://") || loopback.iter().any(|l| url.starts_with(l))
}

fn check(plugin: &str, provider: &Provider) -> Res<()> {
    if !valid_id(plugin) {
        return Err(Error::msg(format!("\"{plugin}\" isn't a plugin id")));
    }
    if provider.client_id.trim().is_empty() {
        return Err(Error::msg("the client ID is missing"));
    }
    for url in [Some(&provider.auth_url), Some(&provider.token_url), provider.revoke_url.as_ref()].into_iter().flatten() {
        if !secure(url) {
            return Err(Error::msg(format!("{url} isn't an https:// address")));
        }
    }
    Ok(())
}

/// The account a plugin signs in to with a client: one keychain entry each.
fn key(plugin: &str, provider: &Provider) -> String {
    format!("oauth|{plugin}|{}|{}", provider.token_url, provider.client_id)
}

/// `n` random bytes, URL-safe.
fn random(n: usize) -> Res<String> {
    let mut bytes = vec![0; n];
    getrandom::fill(&mut bytes).map_err(|e| Error::msg(format!("no randomness: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// PKCE's S256 challenge for a verifier.
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Percent-encodes all but RFC 3986's unreserved characters.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Undoes `encode`, and form encoding's `+` for spaces; a `%` not followed by two hex digits stays.
fn decode(s: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match (bytes[i], bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(hi), Some(lo)) => {
                out.push(hi << 4 | lo);
                i += 2;
            }
            (b'+', ..) => out.push(b' '),
            (b, ..) => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> String {
    pairs.into_iter().map(|(k, v)| format!("{}={}", encode(k), encode(v))).collect::<Vec<_>>().join("&")
}

/// The provider's sign-in page, asking it to come back to `redirect` with a code.
fn sign_in_link(provider: &Provider, redirect: &str, state: &str, verifier: &str) -> String {
    let scope = provider.scopes.join(" ");
    let code_challenge = challenge(verifier);
    let standard = [
        ("response_type", "code"),
        ("client_id", provider.client_id.as_str()),
        ("redirect_uri", redirect),
        ("scope", scope.as_str()),
        ("state", state),
        ("code_challenge", code_challenge.as_str()),
        ("code_challenge_method", "S256"),
    ];
    let extra = provider.params.iter().map(|(k, v)| (k.as_str(), v.as_str()));
    let joiner = if provider.auth_url.contains('?') { '&' } else { '?' };
    format!("{}{joiner}{}", provider.auth_url, query(standard.into_iter().chain(extra)))
}

/// What a request to the loopback address says: `None` when it isn't the provider coming back
/// (a browser asking for a favicon…), else the code or why there is none.
fn callback(request_line: &str, state: &str) -> Option<Result<String, String>> {
    let target = request_line.strip_prefix("GET ")?.split(' ').next()?;
    let params: HashMap<String, String> =
        target.split_once('?')?.1.split('&').filter_map(|pair| pair.split_once('=')).map(|(k, v)| (decode(k), decode(v))).collect();
    if let Some(error) = params.get("error") {
        let detail = params.get("error_description").map(|d| format!(": {d}")).unwrap_or_default();
        return Some(Err(if error == "access_denied" {
            "the sign-in was cancelled".into()
        } else {
            format!("the provider refused: {error}{detail}")
        }));
    }
    let code = params.get("code")?;
    if params.get("state").map(String::as_str) != Some(state) {
        return Some(Err("the browser came back from another sign-in".into()));
    }
    Some(Ok(code.clone()))
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>AiN</title>\
<body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0\"><p>";

fn respond(mut stream: &TcpStream, status: &str, text: &str) {
    let body = format!("{PAGE}{text}</p>");
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Waits for the provider to send the browser back with a code, until `deadline` or until
/// `replaced` says a newer sign-in took over.
fn wait(listener: &TcpListener, state: &str, deadline: Instant, replaced: impl Fn() -> bool) -> Res<String> {
    listener.set_nonblocking(true)?;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                let mut line = String::new();
                if BufReader::new((&stream).take(8 * 1024)).read_line(&mut line).is_err() {
                    continue;
                }
                match callback(line.trim_end(), state) {
                    None => respond(&stream, "404 Not Found", "Nothing here."),
                    Some(Ok(code)) => {
                        respond(&stream, "200 OK", "Signed in. You can close this tab and go back to AiN.");
                        return Ok(code);
                    }
                    Some(Err(why)) => {
                        respond(&stream, "400 Bad Request", &format!("Not signed in: {why}. You can close this tab."));
                        return Err(Error::msg(why));
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                if replaced() {
                    return Err(Error::msg("a newer sign-in took over"));
                }
                if Instant::now() > deadline {
                    return Err(Error::msg("the browser didn't come back in time: try again"));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// What a token endpoint answers.
#[derive(Debug, Deserialize)]
struct Tokens {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Refusal {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

/// Why a token request failed: refused by the provider (with its error code), or not answered.
#[derive(Debug)]
enum Failure {
    Refused(String, String),
    Unreachable(String),
}

impl From<Failure> for Error {
    fn from(f: Failure) -> Self {
        match f {
            Failure::Refused(error, detail) => Error::msg(format!("the provider refused: {error}{detail}")),
            Failure::Unreachable(why) => Error::msg(why),
        }
    }
}

fn post(url: &str, form: &[(&str, &str)]) -> Result<String, Failure> {
    let agent: ureq::Agent =
        ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(30))).build().into();
    let mut response =
        agent.post(url).send_form(form.iter().copied()).map_err(|e| Failure::Unreachable(format!("couldn't reach {url}: {e}")))?;
    let ok = response.status().is_success();
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_BYTES)
        .read_to_string()
        .map_err(|e| Failure::Unreachable(format!("couldn't read {url}: {e}")))?;
    if ok {
        return Ok(body);
    }
    match serde_json::from_str::<Refusal>(&body) {
        Ok(r) => Err(Failure::Refused(r.error, r.error_description.map(|d| format!(": {d}")).unwrap_or_default())),
        Err(_) => Err(Failure::Unreachable(format!("{url} answered {}", response.status()))),
    }
}

fn tokens(url: &str, form: &[(&str, &str)]) -> Result<Tokens, Failure> {
    serde_json::from_str(&post(url, form)?).map_err(|e| Failure::Unreachable(format!("{url} answered something unexpected: {e}")))
}

/// Where refresh tokens are kept: the OS keychain, or memory in tests.
pub trait Vault: Send + Sync {
    fn get(&self, key: &str) -> Res<Option<String>>;
    fn set(&self, key: &str, secret: &str) -> Res<()>;
    fn delete(&self, key: &str) -> Res<()>;
}

/// The OS keychain: Credential Manager, the macOS Keychain, or the Secret Service on Linux.
struct Keychain;

fn keychain(e: keyring::Error) -> Error {
    Error::msg(format!("the system keychain refused: {e}"))
}

impl Vault for Keychain {
    fn get(&self, key: &str) -> Res<Option<String>> {
        match keyring::Entry::new(SERVICE, key).and_then(|e| e.get_password()) {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain(e)),
        }
    }

    fn set(&self, key: &str, secret: &str) -> Res<()> {
        keyring::Entry::new(SERVICE, key).and_then(|e| e.set_password(secret)).map_err(keychain)
    }

    fn delete(&self, key: &str) -> Res<()> {
        match keyring::Entry::new(SERVICE, key).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain(e)),
        }
    }
}

struct Access {
    token: String,
    until: Instant,
}

/// The accounts plugins signed in to: refresh tokens in a vault, access tokens in memory.
pub struct Accounts {
    vault: Box<dyn Vault>,
    access: Mutex<HashMap<String, Access>>,
    /// The sign-in waiting for the browser, by account: the latest one started.
    waiting: Mutex<HashMap<String, u64>>,
    started: AtomicU64,
}

/// Clears an account's waiting sign-in when it ends, however it ends, unless a newer one took over.
struct Waiting<'a>(&'a Mutex<HashMap<String, u64>>, String, u64);

impl Waiting<'_> {
    fn replaced(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).get(&self.1) != Some(&self.2)
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut waiting = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if waiting.get(&self.1) == Some(&self.2) {
            waiting.remove(&self.1);
        }
    }
}

impl Accounts {
    pub fn new(vault: Box<dyn Vault>) -> Self {
        Self { vault, access: Mutex::default(), waiting: Mutex::default(), started: AtomicU64::new(0) }
    }

    fn remember(&self, key: &str, t: &Tokens) {
        let until = Instant::now() + Duration::from_secs(t.expires_in.unwrap_or(3600));
        self.access.lock().unwrap_or_else(|e| e.into_inner()).insert(key.into(), Access { token: t.access_token.clone(), until });
    }

    fn forget(&self, key: &str) {
        self.access.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    }

    /// Signs `plugin` in: `open` shows the sign-in page in the browser; returns once the provider
    /// sent the user back and the code was exchanged. Signing in again while one waits (its tab
    /// closed, or lost) replaces it: the waiting one ends with an error.
    pub fn sign_in(&self, plugin: &str, provider: &Provider, open: impl FnOnce(&str) -> std::io::Result<()>) -> Res<()> {
        check(plugin, provider)?;
        let key = key(plugin, provider);
        let n = self.started.fetch_add(1, Ordering::Relaxed);
        self.waiting.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone(), n);
        let waiting = Waiting(&self.waiting, key.clone(), n);
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let redirect = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
        let (state, verifier) = (random(16)?, random(48)?);
        open(&sign_in_link(provider, &redirect, &state, &verifier))?;
        let code = wait(&listener, &state, Instant::now() + TIMEOUT, || waiting.replaced())?;
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("client_id", provider.client_id.as_str()),
            ("code_verifier", verifier.as_str()),
        ];
        if let Some(secret) = &provider.client_secret {
            form.push(("client_secret", secret));
        }
        let t = tokens(&provider.token_url, &form)?;
        let refresh =
            t.refresh_token.as_deref().ok_or_else(|| Error::msg("the provider gave no refresh token: ask it for offline access"))?;
        self.vault.set(&key, refresh)?;
        self.remember(&key, &t);
        Ok(())
    }

    /// A valid access token, refreshed when needed; `None` when signed out, or when the provider
    /// no longer accepts the sign-in (revoked, expired): the plugin then asks the user to sign in.
    pub fn token(&self, plugin: &str, provider: &Provider) -> Res<Option<String>> {
        check(plugin, provider)?;
        let key = key(plugin, provider);
        if let Some(a) = self.access.lock().unwrap_or_else(|e| e.into_inner()).get(&key)
            && a.until > Instant::now() + MARGIN
        {
            return Ok(Some(a.token.clone()));
        }
        let Some(refresh) = self.vault.get(&key)? else { return Ok(None) };
        let mut form =
            vec![("grant_type", "refresh_token"), ("refresh_token", refresh.as_str()), ("client_id", provider.client_id.as_str())];
        if let Some(secret) = &provider.client_secret {
            form.push(("client_secret", secret));
        }
        match tokens(&provider.token_url, &form) {
            Ok(t) => {
                // Some providers hand out a new refresh token each time.
                if let Some(next) = &t.refresh_token {
                    self.vault.set(&key, next)?;
                }
                self.remember(&key, &t);
                Ok(Some(t.access_token))
            }
            Err(Failure::Refused(error, _)) if error == "invalid_grant" => {
                self.vault.delete(&key)?;
                self.forget(&key);
                Ok(None)
            }
            Err(f) => Err(f.into()),
        }
    }

    /// Forgets the account, and revokes the sign-in where the provider allows it.
    pub fn sign_out(&self, plugin: &str, provider: &Provider) -> Res<()> {
        check(plugin, provider)?;
        let key = key(plugin, provider);
        let refresh = self.vault.get(&key)?;
        self.vault.delete(&key)?;
        self.forget(&key);
        if let (Some(url), Some(token)) = (&provider.revoke_url, refresh) {
            // Best effort: signed out here either way.
            let _ = post(url, &[("token", token.as_str())]);
        }
        Ok(())
    }

    /// Whether the plugin has an account with this client, without asking the provider.
    pub fn signed_in(&self, plugin: &str, provider: &Provider) -> Res<bool> {
        check(plugin, provider)?;
        Ok(self.vault.get(&key(plugin, provider))?.is_some())
    }
}

static ACCOUNTS: LazyLock<Accounts> = LazyLock::new(|| Accounts::new(Box::new(Keychain)));

async fn blocking<T: Send + 'static>(work: impl FnOnce(&Accounts) -> Res<T> + Send + 'static) -> Res<T> {
    spawn_blocking(move || work(&ACCOUNTS)).await.map_err(|_| Error::WorkerGone)?
}

/// Opens the provider's sign-in page in the browser; resolves once the user is signed in.
#[tauri::command]
#[specta::specta]
async fn sign_in(plugin: String, provider: Provider) -> Res<()> {
    blocking(move |a| a.sign_in(&plugin, &provider, crate::platform::open_url)).await
}

/// A valid access token for the plugin's account, or `null` when it isn't signed in.
#[tauri::command]
#[specta::specta]
async fn token(plugin: String, provider: Provider) -> Res<Option<String>> {
    blocking(move |a| a.token(&plugin, &provider)).await
}

/// Forgets the plugin's account, revoking it where the provider allows.
#[tauri::command]
#[specta::specta]
async fn sign_out(plugin: String, provider: Provider) -> Res<()> {
    blocking(move |a| a.sign_out(&plugin, &provider)).await
}

/// Whether the plugin has an account with this client, without going online.
#[tauri::command]
#[specta::specta]
async fn signed_in(plugin: String, provider: Provider) -> Res<bool> {
    blocking(move |a| a.signed_in(&plugin, &provider)).await
}

crate::ipc::oauth!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|_| Ok(()))
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, thread};

    use super::*;

    #[derive(Default)]
    struct Memory(Mutex<HashMap<String, String>>);

    impl Vault for Arc<Memory> {
        fn get(&self, key: &str) -> Res<Option<String>> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, secret: &str) -> Res<()> {
            self.0.lock().unwrap().insert(key.into(), secret.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Res<()> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    fn provider(token_url: &str) -> Provider {
        Provider {
            auth_url: "https://accounts.example/auth".into(),
            token_url: token_url.into(),
            revoke_url: None,
            client_id: "client 1".into(),
            client_secret: Some("s3cret".into()),
            scopes: vec!["calendar".into(), "email".into()],
            params: BTreeMap::from([("access_type".into(), "offline".into())]),
        }
    }

    /// A token endpoint on this machine: answers each request with what `answer` makes of its form.
    fn token_server(answer: impl Fn(&HashMap<String, String>) -> (u16, String) + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/token", listener.local_addr().unwrap().port());
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(&stream);
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let form = String::from_utf8(body)
                    .unwrap()
                    .split('&')
                    .filter_map(|p| p.split_once('='))
                    .map(|(k, v)| (decode(k), decode(v)))
                    .collect();
                let (status, json) = answer(&form);
                let _ = write!(
                    &stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                    json.len()
                );
            }
        });
        url
    }

    /// A browser that follows the sign-in link straight back to the app, with `code`.
    fn browser(code: &'static str) -> impl FnOnce(&str) -> std::io::Result<()> {
        move |link| {
            let params: HashMap<String, String> =
                link.split_once('?').unwrap().1.split('&').filter_map(|p| p.split_once('=')).map(|(k, v)| (decode(k), decode(v))).collect();
            let back = format!("{}/?code={code}&state={}", params["redirect_uri"], encode(&params["state"]));
            thread::spawn(move || {
                let _ = ureq::get(&back).call();
            });
            Ok(())
        }
    }

    #[test]
    fn makes_the_pkce_challenge_of_rfc_7636() {
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn links_to_the_sign_in_page_with_every_parameter_encoded() {
        let link = sign_in_link(&provider("https://accounts.example/token"), "http://127.0.0.1:5000", "st", "v");
        assert!(link.starts_with(
            "https://accounts.example/auth?response_type=code&client_id=client%201&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000"
        ));
        assert!(link.contains("&scope=calendar%20email&state=st&code_challenge="));
        assert!(link.ends_with("&code_challenge_method=S256&access_type=offline"));
        let with_query = Provider { auth_url: "https://a.example/auth?tenant=x".into(), ..provider("https://a.example/t") };
        assert!(sign_in_link(&with_query, "r", "s", "v").starts_with("https://a.example/auth?tenant=x&response_type=code"));
    }

    #[test]
    fn reads_the_code_the_browser_comes_back_with() {
        assert_eq!(callback("GET /?code=4%2F0abc&state=st HTTP/1.1", "st"), Some(Ok("4/0abc".into())));
        assert_eq!(callback("GET /?state=st&code=c&scope=a+b HTTP/1.1", "st"), Some(Ok("c".into())));
        assert_eq!(callback("GET /?code=c&state=other HTTP/1.1", "st"), Some(Err("the browser came back from another sign-in".into())));
        assert_eq!(callback("GET /?error=access_denied&state=st HTTP/1.1", "st"), Some(Err("the sign-in was cancelled".into())));
        assert_eq!(callback("GET /favicon.ico HTTP/1.1", "st"), None);
        assert_eq!(callback("POST /?code=c&state=st HTTP/1.1", "st"), None);
    }

    #[test]
    fn decodes_what_it_encodes() {
        for s in ["a b/c?d=e&f", "é…", "100%", "%zz", "%4"] {
            assert_eq!(decode(&encode(s)), s);
        }
        assert_eq!(decode("%zz%4"), "%zz%4");
    }

    #[test]
    fn refuses_plain_http_providers_bad_ids_and_missing_clients() {
        let ok = provider("https://accounts.example/token");
        assert!(check("calendar", &ok).is_ok());
        assert!(check("calendar", &provider("http://127.0.0.1:9/token")).is_ok());
        assert!(check("calendar", &provider("http://evil.example/token")).is_err());
        assert!(check("calendar", &Provider { revoke_url: Some("http://evil.example/r".into()), ..ok.clone() }).is_err());
        assert!(check("Calendar!", &ok).is_err());
        assert!(check("calendar", &Provider { client_id: " ".into(), ..ok }).is_err());
    }

    #[test]
    fn signs_in_refreshes_and_signs_out() {
        let refreshes = Arc::new(Mutex::new(0));
        let counted = refreshes.clone();
        let url = token_server(move |form| match form["grant_type"].as_str() {
            "authorization_code" => {
                assert_eq!((form["code"].as_str(), form["client_secret"].as_str()), ("the-code", "s3cret"));
                assert!(form["redirect_uri"].starts_with("http://127.0.0.1:"));
                assert!(form["code_verifier"].len() >= 43);
                (200, r#"{"access_token":"a1","expires_in":30,"refresh_token":"r1"}"#.into())
            }
            "refresh_token" if form["refresh_token"] == "r1" => {
                *counted.lock().unwrap() += 1;
                (200, r#"{"access_token":"a2","expires_in":3600}"#.into())
            }
            _ => (400, r#"{"error":"invalid_grant"}"#.into()),
        });
        let vault = Arc::new(Memory::default());
        let accounts = Accounts::new(Box::new(vault.clone()));
        let p = provider(&url);
        assert!(!accounts.signed_in("calendar", &p).unwrap());
        assert_eq!(accounts.token("calendar", &p).unwrap(), None);

        accounts.sign_in("calendar", &p, browser("the-code")).unwrap();
        assert!(accounts.signed_in("calendar", &p).unwrap());
        assert_eq!(vault.get(&key("calendar", &p)).unwrap().as_deref(), Some("r1"));
        // a1 expires within the margin: it is refreshed, then a2 is reused.
        assert_eq!(accounts.token("calendar", &p).unwrap().as_deref(), Some("a2"));
        assert_eq!(accounts.token("calendar", &p).unwrap().as_deref(), Some("a2"));
        assert_eq!(*refreshes.lock().unwrap(), 1);
        // Another plugin, same client: not signed in.
        assert_eq!(accounts.token("other", &p).unwrap(), None);

        accounts.sign_out("calendar", &p).unwrap();
        assert!(!accounts.signed_in("calendar", &p).unwrap());
        assert_eq!(accounts.token("calendar", &p).unwrap(), None);
    }

    #[test]
    fn forgets_a_sign_in_the_provider_no_longer_accepts() {
        let url = token_server(|_| (400, r#"{"error":"invalid_grant","error_description":"Token has been revoked."}"#.into()));
        let vault = Arc::new(Memory::default());
        let accounts = Accounts::new(Box::new(vault.clone()));
        let p = provider(&url);
        vault.set(&key("calendar", &p), "revoked").unwrap();
        assert_eq!(accounts.token("calendar", &p).unwrap(), None);
        assert!(!accounts.signed_in("calendar", &p).unwrap());
    }

    #[test]
    fn says_why_a_refresh_failed_otherwise_and_keeps_the_account() {
        let url = token_server(|_| (500, "oops".into()));
        let vault = Arc::new(Memory::default());
        let accounts = Accounts::new(Box::new(vault.clone()));
        let p = provider(&url);
        vault.set(&key("calendar", &p), "r1").unwrap();
        assert!(accounts.token("calendar", &p).unwrap_err().to_string().contains("answered 500"));
        assert!(accounts.signed_in("calendar", &p).unwrap());
    }

    #[test]
    fn stops_when_the_user_cancels_in_the_browser_and_lets_them_try_again() {
        let url = token_server(|_| (200, r#"{"access_token":"a","refresh_token":"r"}"#.into()));
        let accounts = Accounts::new(Box::new(Arc::new(Memory::default())));
        let p = provider(&url);
        let cancel = |link: &str| {
            let redirect = decode(link.split("redirect_uri=").nth(1).unwrap().split('&').next().unwrap());
            thread::spawn(move || {
                let _ = ureq::get(&format!("{redirect}/favicon.ico")).call();
                let _ = ureq::get(&format!("{redirect}/?error=access_denied")).call();
            });
            Ok(())
        };
        assert_eq!(accounts.sign_in("calendar", &p, cancel).unwrap_err().to_string(), "the sign-in was cancelled");
        accounts.sign_in("calendar", &p, browser("c")).unwrap();
    }

    #[test]
    fn a_new_sign_in_replaces_one_still_waiting_for_the_browser() {
        let url = token_server(|_| (200, r#"{"access_token":"a","refresh_token":"r"}"#.into()));
        let accounts = Accounts::new(Box::new(Arc::new(Memory::default())));
        let p = provider(&url);
        let (opened, link) = std::sync::mpsc::channel();
        thread::scope(|s| {
            // The first sign-in's tab was lost: the browser never comes back.
            let first = s.spawn(|| {
                accounts.sign_in("calendar", &p, move |_| {
                    opened.send(()).unwrap();
                    Ok(())
                })
            });
            link.recv().unwrap();
            accounts.sign_in("calendar", &p, browser("c")).unwrap();
            assert_eq!(first.join().unwrap().unwrap_err().to_string(), "a newer sign-in took over");
        });
        assert!(accounts.signed_in("calendar", &p).unwrap());
        assert!(accounts.waiting.lock().unwrap().is_empty());
    }

    #[test]
    fn refuses_a_provider_without_refresh_tokens() {
        let url = token_server(|_| (200, r#"{"access_token":"a"}"#.into()));
        let accounts = Accounts::new(Box::new(Arc::new(Memory::default())));
        let err = accounts.sign_in("calendar", &provider(&url), browser("c")).unwrap_err();
        assert!(err.to_string().contains("no refresh token"));
    }
}
