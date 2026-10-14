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

use serde_json::Value;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder,
    plugin::{Builder, TauriPlugin},
};
use tauri_plugin_autostart::ManagerExt;

use crate::{Error, Res};

pub const EVENT: &str = "settings:changed";
const FILE: &str = "settings.json";
const WINDOW: &str = "settings";

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

#[tauri::command]
fn get(store: State<'_, Store>) -> Value {
    read(&store.path)
}

#[tauri::command]
fn set<R: Runtime>(app: AppHandle<R>, store: State<'_, Store>, value: Value) -> Res<()> {
    let _guard = store.lock.lock().unwrap_or_else(|e| e.into_inner());
    write(&store.path, &value)?;
    app.emit(EVENT, value)?;
    Ok(())
}

/// Async so the window is created off the IPC callback; creating it inside one deadlocks on Windows.
#[tauri::command]
async fn open<R: Runtime>(app: AppHandle<R>) -> Res<()> {
    show(&app)
}

#[tauri::command]
fn autostart<R: Runtime>(app: AppHandle<R>) -> Res<bool> {
    app.autolaunch().is_enabled().map_err(|e| Error::Autostart(e.to_string()))
}

#[tauri::command]
fn set_autostart<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Res<()> {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    result.map_err(|e| Error::Autostart(e.to_string()))
}

/// Shows the settings window, creating it the first time.
pub fn show<R: Runtime>(app: &AppHandle<R>) -> Res<()> {
    if let Some(w) = app.get_webview_window(WINDOW) {
        w.unminimize()?;
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("settings.html".into()))
        .title("Island settings")
        .inner_size(820.0, 600.0)
        .min_inner_size(640.0, 480.0)
        .center()
        .focused(true)
        .build()?;
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("settings")
        .invoke_handler(tauri::generate_handler![get, set, open, autostart, set_autostart])
        .setup(|app, _| {
            let path = app.path().app_config_dir()?.join(FILE);
            app.manage(Store { path, lock: Mutex::new(()) });
            Ok(())
        })
        .build()
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
}
