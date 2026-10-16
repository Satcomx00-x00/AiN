//! Third-party plugins: JavaScript modules the user drops in the app's `plugins` folder, either as
//! `<name>.js` or as `<name>/index.js`. The backend only finds and reads them; the island loads,
//! validates and runs them (only the ones enabled in Settings).

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, State, Wry, plugin::TauriPlugin};

use crate::Res;

const FOLDER: &str = "plugins";
/// Larger files are skipped: a plugin is a small script, not a bundle of assets.
const MAX_BYTES: u64 = 1024 * 1024;

/// A plugin file found on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct Found {
    /// Where it came from, relative to the plugins folder, e.g. "pomodoro.js" or "weather/index.js".
    pub file: String,
    /// The module's source, or `None` (with `problem`) if it couldn't be read.
    pub source: Option<String>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct Listing {
    /// The folder plugins are read from.
    pub dir: String,
    pub plugins: Vec<Found>,
}

struct Folder(PathBuf);

/// The folder plugins are read from.
pub fn dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join(FOLDER))
}

/// Plugin entry points in `dir`, sorted by name: `*.js` files and `*/index.js`.
pub fn entries(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(read) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<(String, PathBuf)> = read
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                let index = path.join("index.js");
                index.is_file().then(|| (format!("{name}/index.js"), index))
            } else {
                name.to_ascii_lowercase().ends_with(".js").then_some((name, path))
            }
        })
        .collect();
    out.sort();
    out
}

pub fn load(file: String, path: &Path) -> Found {
    let read = fs::metadata(path).map_err(|e| e.to_string()).and_then(|meta| match meta.len() > MAX_BYTES {
        true => Err(format!("larger than {} KB", MAX_BYTES / 1024)),
        false => fs::read_to_string(path).map_err(|e| e.to_string()),
    });
    match read {
        Ok(source) => Found { file, source: Some(source), problem: None },
        Err(problem) => Found { file, source: None, problem: Some(problem) },
    }
}

/// Every plugin in the folder, with its source.
#[tauri::command]
#[specta::specta]
fn list(folder: State<'_, Folder>) -> Listing {
    Listing {
        dir: folder.0.to_string_lossy().into_owned(),
        plugins: entries(&folder.0).into_iter().map(|(file, path)| load(file, &path)).collect(),
    }
}

/// Shows the plugins folder in the file manager, creating it first.
#[tauri::command]
#[specta::specta]
async fn open_dir(folder: State<'_, Folder>) -> Res<()> {
    fs::create_dir_all(&folder.0)?;
    crate::platform::reveal(&folder.0)?;
    Ok(())
}

crate::ipc::extensions!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app: &AppHandle| {
        app.manage(Folder(dir(app)?));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_scripts_and_folder_plugins_only() {
        let dir = std::env::temp_dir().join(format!("island-extensions-{}", std::process::id()));
        fs::create_dir_all(dir.join("weather")).unwrap();
        fs::create_dir_all(dir.join("empty")).unwrap();
        fs::write(dir.join("weather/index.js"), "export default () => null").unwrap();
        fs::write(dir.join("pomodoro.js"), "export default () => null").unwrap();
        fs::write(dir.join("notes.txt"), "not a plugin").unwrap();

        let names: Vec<String> = entries(&dir).into_iter().map(|(file, _)| file).collect();
        assert_eq!(names, ["pomodoro.js", "weather/index.js"]);
        let found = load("pomodoro.js".into(), &dir.join("pomodoro.js"));
        assert_eq!(found.source.as_deref(), Some("export default () => null"));
        assert!(load("gone.js".into(), &dir.join("gone.js")).problem.is_some());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_folder_has_no_plugins() {
        assert!(entries(Path::new("/definitely/not/here")).is_empty());
    }
}
