//! Self-update, on Windows (NSIS/MSI), macOS (.app) and Linux (AppImage, .deb, .rpm), through
//! `tauri-plugin-updater`.
//!
//! Each release publishes, next to its installers, a `latest.json` manifest (version, notes, and a
//! download URL plus signature per platform) built by `tauri-action`. The app reads the latest
//! one from GitHub Releases ([`REPO`]), compares versions, and on the user's go downloads
//! the installer for its own platform and bundle type, checks its signature against the public key
//! in `tauri.conf.json`, installs it and restarts.
//!
//! The app only ever checks on its own (shortly after launch, then every few hours); downloading
//! and installing wait for the user. Builds without a public key, debug builds and copies installed by
//! npm or bun (which update them) report `disabled` and never reach the network.

use std::{
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Url, Wry, plugin::TauriPlugin};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_specta::Event;

use crate::{Error, Res};

/// The GitHub repository (`owner/repo`) whose releases carry `latest.json`.
pub const REPO: &str = "Satcomx00-x00/AiN";

/// The latest release's `latest.json`.
pub fn manifest(repo: &str) -> String {
    format!("https://github.com/{repo}/releases/latest/download/latest.json")
}

/// Overrides where `latest.json` is read from, to try updates against a local server (see
/// docs/updates.md). The signature is checked all the same; plain `http://` also needs
/// `dangerousInsecureTransportProtocol` in the build's updater config.
const MANIFEST_OVERRIDE: &str = "AIN_UPDATE_URL";

/// `latest.json`'s URL: GitHub's, unless overridden.
fn manifest_url() -> String {
    std::env::var(MANIFEST_OVERRIDE).ok().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| manifest(REPO))
}

/// The releases page, for people who'd rather download by hand.
pub fn releases(repo: &str) -> String {
    format!("https://github.com/{repo}/releases")
}

/// First check, once the app has settled after launch.
const FIRST_CHECK: Duration = Duration::from_secs(30);
/// Then this often, for apps left running for days.
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Where the updater stands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum State {
    /// Updates are off in this build (debug build, or no public key configured).
    Disabled {
        reason: String,
    },
    /// Not checked yet.
    Idle,
    Checking,
    UpToDate,
    /// A newer version is out; `notes` are its release notes (Markdown).
    Available {
        version: String,
        notes: Option<String>,
    },
    /// Bytes received so far, out of `total` when the server says.
    Downloading {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    /// Downloaded and verified; the installer runs, then the app restarts.
    Installing {
        version: String,
    },
    /// The last check or install failed; checking again starts over.
    Failed {
        message: String,
    },
}

impl State {
    /// A check or an install is under way: nothing else may start.
    pub fn busy(&self) -> bool {
        matches!(self, Self::Checking | Self::Downloading { .. } | Self::Installing { .. })
    }

    /// A check may start from here.
    pub fn can_check(&self) -> bool {
        !self.busy() && !matches!(self, Self::Disabled { .. })
    }
}

/// What the settings window shows: the running version, the updater's state, and where releases live.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Report {
    pub current: String,
    pub state: State,
    pub releases: String,
}

/// Sent on every change of state, download progress included.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct UpdateChanged(pub Report);

struct Updates {
    report: Mutex<Report>,
    /// The update the last check found, ready to download.
    pending: Mutex<Option<Update>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Updates {
    fn report(&self) -> Report {
        lock(&self.report).clone()
    }

    /// Moves to `next` if `allowed` holds for the current state, atomically; tells whether it did.
    fn transition(&self, app: &AppHandle, allowed: impl FnOnce(&State) -> bool, next: State) -> bool {
        let report = {
            let mut report = lock(&self.report);
            if !allowed(&report.state) {
                return false;
            }
            report.state = next;
            report.clone()
        };
        emit(app, report);
        true
    }

    fn set(&self, app: &AppHandle, next: State) -> Report {
        self.transition(app, |_| true, next);
        self.report()
    }
}

fn emit(app: &AppHandle, report: Report) {
    if let Err(e) = UpdateChanged(report).emit(app) {
        eprintln!("updater: {e}");
    }
}

/// Whether this path lies in a package manager's install (npm, bun, pnpm, yarn: all `node_modules`).
fn in_node_modules(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == "node_modules")
}

/// The installed file: the AppImage itself rather than its mount point, else the executable.
fn installed_path() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from).or_else(|| std::env::current_exe().ok())
}

/// Why updates are off in this build, if they are.
fn disabled_reason(app: &AppHandle) -> Option<&'static str> {
    if cfg!(debug_assertions) {
        return Some("Development build: updates are off.");
    }
    if installed_path().is_some_and(|p| in_node_modules(&p)) {
        return Some("Installed with npm or bun: update with `bun update -g @satcomx00/ain`.");
    }
    let pubkey = app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str());
    pubkey.is_none_or(|k| k.trim().is_empty()).then_some("This build has no update key: updates are off.")
}

/// Asks the release host for a newer version.
async fn find(app: &AppHandle) -> Result<Option<Update>, String> {
    let url = Url::parse(&manifest_url()).map_err(|e| e.to_string())?;
    let updater = app.updater_builder().endpoints(vec![url]).and_then(|b| b.build()).map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

/// Checks now, unless updates are off or a check or install is already running; returns where
/// that leaves the updater.
pub async fn check_now(app: &AppHandle) -> Report {
    let updates = app.state::<Updates>();
    if !updates.transition(app, State::can_check, State::Checking) {
        return updates.report();
    }
    let next = match find(app).await {
        Ok(Some(update)) => {
            let state = State::Available { version: update.version.clone(), notes: update.body.clone() };
            *lock(&updates.pending) = Some(update);
            state
        }
        Ok(None) => State::UpToDate,
        Err(message) => State::Failed { message },
    };
    updates.set(app, next)
}

/// Emits download progress at most once per percent (or per 512 KiB when the size is unknown),
/// so a fast download doesn't flood the windows with events.
#[derive(Debug, Default)]
pub struct Progress {
    pub received: u64,
    reported: u64,
}

impl Progress {
    const STEP_UNKNOWN: u64 = 512 * 1024;

    /// Adds a chunk; true when it's worth reporting.
    pub fn add(&mut self, chunk: u64, total: Option<u64>) -> bool {
        self.received += chunk;
        let step = total.map_or(Self::STEP_UNKNOWN, |t| (t / 100).max(1));
        let due = self.received - self.reported >= step || total.is_some_and(|t| self.received >= t);
        if due {
            self.reported = self.received;
        }
        due
    }
}

#[tauri::command]
#[specta::specta]
fn status(app: AppHandle) -> Report {
    app.state::<Updates>().report()
}

/// Checks for a newer version now.
#[tauri::command]
#[specta::specta]
async fn check(app: AppHandle) -> Report {
    check_now(&app).await
}

/// Downloads the update the last check found, installs it and restarts the app. On Windows the
/// installer closes the app itself.
#[tauri::command]
#[specta::specta]
async fn install(app: AppHandle) -> Res<()> {
    let updates = app.state::<Updates>();
    let Some(update) = lock(&updates.pending).take() else {
        return Err(Error::msg("No update to install: check for updates first."));
    };
    let version = update.version.clone();
    let start = State::Downloading { version: version.clone(), received: 0, total: None };
    if !updates.transition(&app, |s| matches!(s, State::Available { .. }), start) {
        return Err(Error::msg("An update is already being installed."));
    }

    let mut progress = Progress::default();
    let result = update
        .download_and_install(
            |chunk, total| {
                if progress.add(chunk as u64, total) {
                    let state = State::Downloading { version: version.clone(), received: progress.received, total };
                    app.state::<Updates>().set(&app, state);
                }
            },
            || _ = app.state::<Updates>().set(&app, State::Installing { version: version.clone() }),
        )
        .await;
    if let Err(e) = result {
        let message = e.to_string();
        updates.set(&app, State::Failed { message: message.clone() });
        return Err(Error::Message(message));
    }
    app.restart()
}

/// Opens the releases page in the browser.
#[tauri::command]
#[specta::specta]
fn open_releases() -> Res<()> {
    crate::platform::open_url(&releases(REPO))?;
    Ok(())
}

/// Checks shortly after launch, then every few hours, on a thread of its own.
fn schedule(app: AppHandle) -> std::io::Result<()> {
    thread::Builder::new().name("update-check".into()).spawn(move || {
        thread::sleep(FIRST_CHECK);
        loop {
            tauri::async_runtime::block_on(check_now(&app));
            thread::sleep(EVERY);
        }
    })?;
    Ok(())
}

crate::ipc::updates!();

/// Tauri's updater plugin (download, signature check, install), then ours on top of it, named
/// `updates`: two plugins sharing a name would share its config section, and ours takes none.
pub fn register(app: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    app.plugin(tauri_plugin_updater::Builder::new().build()).plugin(init())
}

fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let disabled = disabled_reason(app);
        let state = disabled.map_or(State::Idle, |reason| State::Disabled { reason: reason.into() });
        let report = Report { current: app.package_info().version.to_string(), state, releases: releases(REPO) };
        app.manage(Updates { report: Mutex::new(report), pending: Mutex::new(None) });
        if disabled.is_none() {
            schedule(app.clone())?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_urls() {
        assert_eq!(manifest("me/app"), "https://github.com/me/app/releases/latest/download/latest.json");
        assert_eq!(releases("me/app"), "https://github.com/me/app/releases");
        assert!(Url::parse(&manifest(REPO)).is_ok());
    }

    #[test]
    fn package_manager_installs() {
        assert!(in_node_modules(Path::new("/usr/lib/node_modules/@satcomx00/ain-linux-x64/AiN.AppImage")));
        assert!(in_node_modules(Path::new("C:/Users/me/.bun/install/global/node_modules/@satcomx00/ain-win32-x64/ain.exe")));
        assert!(!in_node_modules(Path::new("/Applications/AiN.app/Contents/MacOS/AiN")));
        assert!(!in_node_modules(Path::new("/opt/not_node_modules/AiN.AppImage")));
    }

    #[test]
    fn one_thing_at_a_time() {
        let version = || "1.0.0".to_string();
        assert!(State::Idle.can_check());
        assert!(State::UpToDate.can_check());
        assert!(State::Failed { message: "offline".into() }.can_check());
        assert!(State::Available { version: version(), notes: None }.can_check());
        assert!(!State::Checking.can_check());
        assert!(!State::Downloading { version: version(), received: 0, total: None }.can_check());
        assert!(!State::Installing { version: version() }.can_check());
        assert!(!State::Disabled { reason: "dev".into() }.can_check());
    }

    #[test]
    fn progress_reports_each_percent_and_the_end() {
        let mut p = Progress::default();
        assert!(!p.add(5, Some(1000)), "under 1%");
        assert!(p.add(5, Some(1000)), "1% reached");
        assert!(!p.add(9, Some(1000)));
        assert!(p.add(981, Some(1000)), "complete");
        assert_eq!(p.received, 1000);
    }

    #[test]
    fn progress_without_a_size_reports_by_amount() {
        let mut p = Progress::default();
        assert!(!p.add(100 * 1024, None));
        assert!(p.add(412 * 1024, None));
        assert!(!p.add(1, None));
    }

    #[test]
    fn state_crosses_as_tagged_object() {
        let json = serde_json::to_value(State::Downloading { version: "1.2.0".into(), received: 10, total: Some(20) }).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "downloading", "version": "1.2.0", "received": 10, "total": 20 }));
    }
}
