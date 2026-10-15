//! User settings: a JSON file in the app's config folder, broadcast to every window on change,
//! plus the settings window itself and launch-at-login.
//!
//! The file's shape belongs to the frontend, which validates it and fills in defaults, so the
//! backend stores it as-is. A missing or unreadable file reads as `null`.

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, plugin::TauriPlugin};
use tauri_plugin_autostart::ManagerExt;
use tauri_specta::Event;

use crate::{Error, Res};

const FILE: &str = "settings.json";
const WINDOW: &str = "settings";

/// The settings file's content. Its shape belongs to the frontend, which validates it, so the
/// bindings type it `unknown` (and serde_json's own `Value` type is recursive, which specta can't inline).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct Raw(#[specta(type = specta_typescript::Unknown)] pub Value);

/// The settings, as saved; sent to every window (and backend listeners) after each save.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SettingsChanged(pub Raw);

struct Store {
    path: PathBuf,
    /// Serializes writes so two quick saves can't interleave.
    lock: Mutex<()>,
}

pub fn read(path: &Path) -> Value {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

/// Writes through a temporary file and a rename, so a crash never leaves half a file behind.
pub fn write(path: &Path, value: &Value) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(io::Error::other)?)?;
    fs::rename(&tmp, path)
}

/// The saved settings, for features that read their own options.
pub fn current(app: &AppHandle) -> Value {
    app.try_state::<Store>().map_or(Value::Null, |store| read(&store.path))
}

/// One feature's saved option, e.g. `option(&settings, "dictation", "mode")`.
pub fn option<'a>(settings: &'a Value, feature: &str, key: &str) -> Option<&'a Value> {
    settings.get("options")?.get(feature)?.get(key)
}

#[tauri::command]
#[specta::specta]
fn get(store: State<'_, Store>) -> Raw {
    Raw(read(&store.path))
}

#[tauri::command]
#[specta::specta]
fn set(app: AppHandle, store: State<'_, Store>, value: Raw) -> Res<()> {
    let _guard = store.lock.lock().unwrap_or_else(|e| e.into_inner());
    write(&store.path, &value.0)?;
    SettingsChanged(value).emit(&app)?;
    Ok(())
}

/// Takes the settings window somewhere, e.g. "widgets:dictation": a section, then a widget's card.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct Navigate(pub String);

/// A place in the settings window: lowercase words, digits, `-` and `:` (it ends up in a URL).
pub fn valid_target(target: &str) -> bool {
    !target.is_empty() && target.len() <= 64 && target.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == ':')
}

/// Opens the settings window, at `target` if given. Async so the window is created off the IPC
/// callback; creating it inside one deadlocks on Windows.
#[tauri::command]
#[specta::specta]
async fn open(app: AppHandle, target: Option<String>) -> Res<()> {
    show(&app, target.as_deref())
}

/// Asks the island to play a startup animation now, by its id: the Play button in Settings.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PlayGreeting(pub String);

/// A startup animation's id: 2–32 lowercase letters, digits or dashes, starting with a letter.
pub fn valid_greeting(id: &str) -> bool {
    (2..=32).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Plays the startup animation `id` on the island, e.g. "sparkle".
#[tauri::command]
#[specta::specta]
fn play_greeting(app: AppHandle, id: String) -> Res<()> {
    if !valid_greeting(&id) {
        return Err(Error::msg(format!("not a startup animation: {id:?}")));
    }
    PlayGreeting(id).emit(&app)?;
    Ok(())
}

/// How long quitting may take before the process is ended outright.
const QUIT_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// Quits the app entirely: every window closes, the tray icon goes, shortcuts are released and the
/// process ends (background threads with it; helper processes are tied to it, see `platform`).
/// If anything holds the event loop up, the process still ends after `QUIT_GRACE`.
pub fn quit_app(app: &AppHandle) {
    let _ = std::thread::Builder::new().name("quit-deadline".into()).spawn(|| {
        std::thread::sleep(QUIT_GRACE);
        std::process::exit(0);
    });
    app.exit(0);
}

#[tauri::command]
#[specta::specta]
fn quit(app: AppHandle) {
    quit_app(&app);
}

#[tauri::command]
#[specta::specta]
fn autostart(app: AppHandle) -> Res<bool> {
    app.autolaunch().is_enabled().map_err(|e| Error::msg(format!("launch at login: {e}")))
}

#[tauri::command]
#[specta::specta]
fn set_autostart(app: AppHandle, enabled: bool) -> Res<()> {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    result.map_err(|e| Error::msg(format!("launch at login: {e}")))
}

/// Shows the settings window, creating it the first time, at `target` when given.
pub fn show(app: &AppHandle, target: Option<&str>) -> Res<()> {
    if let Some(t) = target
        && !valid_target(t)
    {
        return Err(Error::msg(format!("not a place in the settings: {t:?}")));
    }
    if let Some(w) = app.get_webview_window(WINDOW) {
        w.unminimize()?;
        w.show()?;
        w.set_focus()?;
        if let Some(t) = target {
            Navigate(t.into()).emit(app)?;
        }
        return Ok(());
    }
    let url = target.map_or_else(|| "settings.html".to_string(), |t| format!("settings.html#{t}"));
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App(url.into()))
        .title("Island settings")
        .inner_size(820.0, 600.0)
        .min_inner_size(640.0, 480.0)
        .center()
        .focused(true)
        .build()?;
    Ok(())
}

crate::ipc::settings!();

pub fn init() -> TauriPlugin<tauri::Wry> {
    ipc().plugin(|app| {
        let path = app.path().app_config_dir()?.join(FILE);
        app.manage(Store { path, lock: Mutex::new(()) });
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_tolerates_a_missing_or_broken_file() {
        let dir = std::env::temp_dir().join(format!("island-settings-{}", std::process::id()));
        let path = dir.join(FILE);
        assert_eq!(read(&path), Value::Null);

        let value = serde_json::json!({ "version": 1, "general": { "openDelay": 200 } });
        write(&path, &value).unwrap();
        assert_eq!(read(&path), value);

        fs::write(&path, "{ not json").unwrap();
        assert_eq!(read(&path), Value::Null);
        fs::remove_dir_all(dir).unwrap();
    }

    /// The permissions a window's capability file grants, e.g. "settings:allow-quit".
    fn granted(capability: &str) -> Vec<String> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities").join(format!("{capability}.json"));
        let json: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        json["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str().map(str::to_string)).collect()
    }

    /// Every settings command the island's page calls (shell/windows/island) must be allowed for
    /// its window, or the call is refused at runtime with only a console message to show for it.
    #[test]
    fn the_island_may_call_the_settings_commands_it_uses() {
        let island = granted("default");
        for command in ["get", "set", "open", "quit"] {
            assert!(island.contains(&format!("settings:allow-{command}")), "the island can't call settings|{command}");
        }
    }

    #[test]
    fn greeting_ids_match_the_frontends_rule() {
        for ok in ["hello", "my-wave", "a1", &"a".repeat(32)] {
            assert!(valid_greeting(ok), "{ok}");
        }
        for bad in ["", "a", "Wave", "1wave", "-wave", "wa ve", "wave!", &"a".repeat(33)] {
            assert!(!valid_greeting(bad), "{bad}");
        }
    }

    #[test]
    fn the_settings_window_may_play_a_greeting() {
        assert!(granted("settings").iter().any(|p| p == "settings:default" || p == "settings:allow-play-greeting"));
    }

    #[test]
    fn the_settings_window_may_quit() {
        assert!(granted("settings").iter().any(|p| p == "settings:default" || p == "settings:allow-quit"));
    }

    #[test]
    fn accepts_only_plain_settings_targets() {
        for ok in ["widgets", "widgets:dictation", "widgets:cpu-alarm2"] {
            assert!(valid_target(ok), "{ok}");
        }
        for bad in ["", "Widgets", "widgets/../x", "a b", "x#y", "widgets:<script>", &"a".repeat(65)] {
            assert!(!valid_target(bad), "{bad}");
        }
    }

    #[test]
    fn reads_one_features_option() {
        let settings = serde_json::json!({ "options": { "dictation": { "mode": "hold" } } });
        assert_eq!(option(&settings, "dictation", "mode").and_then(Value::as_str), Some("hold"));
        assert_eq!(option(&settings, "media", "mode"), None);
        assert_eq!(option(&Value::Null, "dictation", "mode"), None);
    }
}
