//! The command palette's backend: the installed apps, an index of the user's files, and what the
//! palette does with them (open, show in their folder, run a command in a terminal, lock, sleep…).
//! The frontend ranks and draws; each OS lists and starts its apps its own way (`windows.rs`,
//! `linux.rs`).

#[cfg(any(target_os = "linux", test))]
mod desktop;
mod files;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as os;
#[cfg(windows)]
use windows as os;

/// Elsewhere there are no apps to list, and nothing to run commands or system actions with.
#[cfg(not(any(windows, target_os = "linux")))]
mod os {
    use std::{io, path::Path};

    use super::{App, SystemAction};

    pub struct Launch;

    pub fn apps() -> Vec<(App, Launch)> {
        Vec::new()
    }
    pub fn launch(_: &Launch) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
    pub fn terminal(_: &str) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
    pub fn reveal(path: &Path) -> io::Result<()> {
        crate::platform::reveal(path.parent().unwrap_or(path))
    }
    pub fn system(_: SystemAction) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Manager, State, Wry, plugin::TauriPlugin};
use tauri_specta::Event;

pub use files::Hit;

use crate::{
    Error, Res,
    shell::settings::{self, SettingsChanged},
};

pub const FEATURE: &str = "palette";
/// Apps are listed again when asked for after this long, so one installed meanwhile shows up.
const APPS_FRESH: Duration = Duration::from_secs(60);
/// The most results one search returns.
const MAX_RESULTS: u32 = 50;

/// An installed app, as the system's own launcher lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct App {
    /// What `launch` takes; unique among the apps listed.
    pub id: String,
    pub name: String,
    /// Other words to find it by (a generic name, keywords, its program's name); may be empty.
    pub keywords: String,
    /// A hint under its name: what it is, or where.
    pub detail: String,
}

/// What the palette can ask of the system itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SystemAction {
    Lock,
    Sleep,
    SignOut,
    Restart,
    ShutDown,
    EmptyTrash,
}

#[derive(Default)]
struct Apps {
    list: Vec<(App, os::Launch)>,
    listed: Option<Instant>,
}

struct Palette {
    apps: Mutex<Apps>,
    files: Arc<files::Index>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Palette {
    /// The apps, listed again first when the last listing is old. Blocking.
    fn apps(&self) -> Vec<App> {
        if lock(&self.apps).listed.is_none_or(|at| at.elapsed() > APPS_FRESH) {
            let list = os::apps();
            *lock(&self.apps) = Apps { list, listed: Some(Instant::now()) };
        }
        lock(&self.apps).list.iter().map(|(app, _)| app.clone()).collect()
    }

    fn launch(&self, id: &str) -> Res<()> {
        let apps = lock(&self.apps);
        let (_, launch) = apps.list.iter().find(|(app, _)| app.id == id).ok_or_else(|| Error::msg("This app is no longer installed."))?;
        os::launch(launch).map_err(|e| Error::msg(format!("Couldn't start it: {e}")))
    }
}

/// The folders to index, from the settings: the home folder and the ones added, or none when
/// file search is off.
fn roots(settings: &Value, home: Option<&Path>) -> Vec<PathBuf> {
    if settings::option(settings, FEATURE, "files").and_then(Value::as_bool) == Some(false) {
        return Vec::new();
    }
    let added = settings::option(settings, FEATURE, "folders").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
    let mut roots: Vec<PathBuf> = Vec::new();
    for root in home.map(Path::to_path_buf).into_iter().chain(added.filter_map(|f| files::expand(f.trim(), home))) {
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

fn limit(n: u32) -> usize {
    n.clamp(1, MAX_RESULTS) as usize
}

/// Blocking work off the async runtime's threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| Error::msg(e.to_string()))?
}

/// The installed apps. The first call after a minute lists them again.
#[tauri::command]
#[specta::specta]
async fn apps(app: AppHandle) -> Res<Vec<App>> {
    blocking(move || Ok(app.state::<Palette>().apps())).await
}

/// Starts an app `apps` listed.
#[tauri::command]
#[specta::specta]
async fn launch(app: AppHandle, id: String) -> Res<()> {
    blocking(move || app.state::<Palette>().launch(&id)).await
}

/// Files and folders whose name has every word of `query`, best first.
#[tauri::command]
#[specta::specta]
async fn files(palette: State<'_, Palette>, query: String, limit: u32) -> Res<Vec<Hit>> {
    let home = dirs::home_dir();
    Ok(palette.files.search(&query, self::limit(limit)).iter().map(|item| files::hit(&item.path, item.dir, home.as_deref())).collect())
}

/// The entries of the folder a typed path points at ("~/Doc", "C:\Users\"), whose name starts
/// with its last part.
#[tauri::command]
#[specta::specta]
async fn browse(path: String, limit: u32) -> Res<Vec<Hit>> {
    blocking(move || {
        let home = dirs::home_dir();
        Ok(files::browse(&path, home.as_deref(), self::limit(limit))
            .into_iter()
            .map(|(p, dir)| files::hit(&p, dir, home.as_deref()))
            .collect())
    })
    .await
}

/// Opens a file or a folder with its default app.
#[tauri::command]
#[specta::specta]
async fn open(path: String) -> Res<()> {
    blocking(move || Ok(crate::platform::open_path(Path::new(&path))?)).await
}

/// Shows a file in its folder, selected where the file manager can.
#[tauri::command]
#[specta::specta]
async fn reveal(path: String) -> Res<()> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(Error::msg("It is no longer there."));
    }
    blocking(move || Ok(os::reveal(&path)?)).await
}

/// Runs a command line in a new terminal window, which stays open after it.
#[tauri::command]
#[specta::specta]
async fn run(command: String) -> Res<()> {
    if command.trim().is_empty() {
        return Err(Error::msg("Type a command to run."));
    }
    blocking(move || os::terminal(command.trim()).map_err(|e| Error::msg(format!("Couldn't open a terminal: {e}")))).await
}

/// Locks, sleeps, signs out, restarts, shuts down, or empties the trash.
#[tauri::command]
#[specta::specta]
async fn system(action: SystemAction) -> Res<()> {
    blocking(move || os::system(action).map_err(|e| Error::msg(format!("Couldn't do it: {e}")))).await
}

/// Opens an https link in the default browser.
#[tauri::command]
#[specta::specta]
async fn open_url(url: String) -> Res<()> {
    Ok(crate::platform::open_url(&url)?)
}

crate::ipc::palette!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let home = dirs::home_dir();
        let files = files::Index::new();
        files.set_roots(roots(&settings::current(app), home.as_deref()));
        app.manage(Palette { apps: Mutex::default(), files: Arc::clone(&files) });
        SettingsChanged::listen_any(app, move |event| files.set_roots(roots(&event.payload.0.0, home.as_deref())));
        // Lists the apps now, so the palette's first opening finds them ready.
        let handle = app.clone();
        thread::Builder::new().name("palette-apps".into()).spawn(move || drop(handle.state::<Palette>().apps()))?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn indexes_home_and_added_folders_unless_turned_off() {
        let (home, shared) = if cfg!(windows) { (r"C:\Users\me", r"D:\shared") } else { ("/home/me", "/srv/shared") };
        let home = Path::new(home);
        let settings = json!({ "options": { "palette": { "folders": ["~/Work", shared, "relative", "", "~"] } } });
        assert_eq!(roots(&settings, Some(home)), [home.to_path_buf(), home.join("Work"), PathBuf::from(shared)]);
        assert_eq!(roots(&Value::Null, Some(home)), [home.to_path_buf()]);
        assert!(roots(&json!({ "options": { "palette": { "files": false } } }), Some(home)).is_empty());
    }

    #[test]
    fn limits_results() {
        assert_eq!((limit(0), limit(8), limit(500)), (1, 8, MAX_RESULTS as usize));
    }

    #[test]
    fn system_actions_cross_as_camel_case() {
        assert_eq!(serde_json::to_value(SystemAction::ShutDown).unwrap(), json!("shutDown"));
        assert_eq!(serde_json::from_value::<SystemAction>(json!("emptyTrash")).unwrap(), SystemAction::EmptyTrash);
    }
}
