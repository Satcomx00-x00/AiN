//! The update flow end to end, minus the installer: a Tauri app (mock runtime) with the real
//! updater plugin reads a `latest.json` from a local HTTP server, finds the newer version,
//! downloads it and checks its signature, on every OS CI runs on.
//!
//! The fixtures in `tests/fixtures/updater/` are signed with a test-only key whose private half
//! was thrown away; to change `update.bin`, make a new pair and re-sign:
//!
//! ```sh
//! bun tauri signer generate --ci -p "" -w /tmp/test.key
//! bun tauri signer sign -f /tmp/test.key -p "" tests/fixtures/updater/update.bin
//! cp /tmp/test.key.pub tests/fixtures/updater/test.key.pub
//! ```

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    path::PathBuf,
    sync::Arc,
    thread,
    time::Duration,
};

use serde_json::json;
use tauri::{App, Url, test::MockRuntime};
use tauri_plugin_updater::UpdaterExt;

const CURRENT: &str = "0.1.0";
/// The updater's lookup key in `latest.json`, set explicitly so the test reads the same entry on
/// every OS (the real app looks up `{os}-{arch}`, e.g. `windows-x86_64`).
const TARGET: &str = "test";

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/updater").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn text(name: &str) -> String {
    String::from_utf8(fixture(name)).unwrap().trim().to_string()
}

/// A tiny HTTP server answering GETs from a fixed table of paths; returns its base URL.
fn serve(routes: HashMap<&'static str, Vec<u8>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let routes = Arc::new(routes);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let routes = Arc::clone(&routes);
            thread::spawn(move || {
                let mut reader = BufReader::new(&stream);
                let mut request = String::new();
                if reader.read_line(&mut request).is_err() {
                    return;
                }
                // Skip the headers: nothing in them matters here.
                let mut line = String::new();
                while reader.read_line(&mut line).is_ok_and(|n| n > 2) {
                    line.clear();
                }
                let path = request.split_whitespace().nth(1).unwrap_or("/");
                let (status, body) = match routes.get(path) {
                    Some(body) => ("200 OK", body.as_slice()),
                    None => ("404 Not Found", &b"not found"[..]),
                };
                let mut out = &stream;
                let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = out.write_all(head.as_bytes()).and_then(|()| out.write_all(body));
            });
        }
    });
    base
}

/// A release manifest as `tauri-action` writes it, with one entry for [`TARGET`].
fn manifest(version: &str, url: &str, signature: &str) -> Vec<u8> {
    let manifest = json!({
        "version": version,
        "notes": "### Features\n- Something new",
        "pub_date": "2026-10-16T12:00:00Z",
        "platforms": { TARGET: { "url": url, "signature": signature } }
    });
    serde_json::to_vec(&manifest).unwrap()
}

/// An app at version [`CURRENT`] trusting `pubkey`.
fn app(pubkey: &str) -> App<MockRuntime> {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert("updater".into(), json!({ "pubkey": pubkey, "dangerousInsecureTransportProtocol": true }));
    context.package_info_mut().version = CURRENT.parse().unwrap();
    tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context).unwrap()
}

/// Checks `base/latest.json` from an app trusting `pubkey`; returns the update found, if any.
fn check(pubkey: &str, base: &str) -> Option<tauri_plugin_updater::Update> {
    let app = app(pubkey);
    let url = Url::parse(&format!("{base}/latest.json")).unwrap();
    let updater =
        app.handle().updater_builder().target(TARGET).timeout(Duration::from_secs(10)).endpoints(vec![url]).unwrap().build().unwrap();
    tauri::async_runtime::block_on(updater.check()).expect("the check itself should succeed")
}

fn download(update: &tauri_plugin_updater::Update) -> Result<Vec<u8>, tauri_plugin_updater::Error> {
    tauri::async_runtime::block_on(update.download(|_, _| {}, || {}))
}

/// Serves a release `version` whose download is `payload`, signed (or not) by the fixture signature.
fn release(version: &str, payload: Vec<u8>) -> String {
    // The manifest needs the server's address, which only exists once it runs: serve the payload
    // first, then the manifest from a second server pointing at it.
    let files = serve(HashMap::from([("/update.bin", payload)]));
    serve(HashMap::from([("/latest.json", manifest(version, &format!("{files}/update.bin"), &text("update.bin.sig")))]))
}

#[test]
fn finds_downloads_and_verifies_a_newer_signed_version() {
    let base = release("0.2.0", fixture("update.bin"));
    let update = check(&text("test.key.pub"), &base).expect("0.2.0 is newer than 0.1.0");
    assert_eq!(update.version, "0.2.0");
    assert_eq!(update.current_version, CURRENT);
    assert_eq!(update.body.as_deref(), Some("### Features\n- Something new"));
    let bytes = download(&update).expect("a download matching its signature is accepted");
    assert_eq!(bytes, fixture("update.bin"));
}

#[test]
fn rejects_a_download_that_does_not_match_its_signature() {
    let mut tampered = fixture("update.bin");
    tampered[0] ^= 1;
    let update = check(&text("test.key.pub"), &release("0.2.0", tampered)).unwrap();
    assert!(download(&update).is_err(), "one flipped bit must fail the signature check");
}

#[test]
fn rejects_a_download_signed_by_another_key() {
    // The app's real key: the fixture was signed by the test key, which it must not trust.
    let update = check(&production_pubkey(), &release("0.2.0", fixture("update.bin"))).unwrap();
    assert!(download(&update).is_err(), "a signature from a key the app doesn't trust must fail");
}

#[test]
fn same_or_older_version_is_no_update() {
    let pubkey = text("test.key.pub");
    assert!(check(&pubkey, &release(CURRENT, fixture("update.bin"))).is_none());
    assert!(check(&pubkey, &release("0.0.9", fixture("update.bin"))).is_none());
}

fn production_pubkey() -> String {
    let conf: serde_json::Value =
        serde_json::from_slice(&std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json")).unwrap()).unwrap();
    conf["plugins"]["updater"]["pubkey"].as_str().unwrap_or_default().to_string()
}

/// Release builds only update with a public key; a test key must never ship.
#[test]
fn the_app_ships_a_real_public_key() {
    let pubkey = production_pubkey();
    assert!(!pubkey.is_empty(), "plugins.updater.pubkey is empty in tauri.conf.json: release builds won't update");
    assert_ne!(pubkey, text("test.key.pub"), "tauri.conf.json carries the test key");
}
