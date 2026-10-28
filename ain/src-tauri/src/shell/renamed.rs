//! The app was called "widget" (identifier `dev.satcom.widget`) before it became AiN. Its settings,
//! plugins and downloaded speech models live in folders named after the identifier, and launching
//! at login is registered under the old name: on the first start as AiN, both carry over.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// The identifier the app had before.
pub const OLD_ID: &str = "dev.satcom.widget";
/// The app's identifier now; `tauri.conf.json` must say the same.
pub const NEW_ID: &str = "dev.satcom.ain";
/// The name the old launch-at-login entry was registered under.
const OLD_NAME: &str = "widget";

/// Moves `<base>/OLD_ID` to `<base>/NEW_ID` in each base folder where the old folder exists and
/// nothing is in the way yet; each folder once, even when two bases are the same (Windows keeps
/// config and data together). Returns the folders that moved.
pub fn move_folders(bases: &[PathBuf], log: impl Fn(String)) -> Vec<PathBuf> {
    let mut seen: Vec<&Path> = Vec::new();
    let mut moved = Vec::new();
    for base in bases {
        if seen.contains(&base.as_path()) {
            continue;
        }
        seen.push(base);
        let (old, new) = (base.join(OLD_ID), base.join(NEW_ID));
        if !old.is_dir() || new.exists() {
            continue;
        }
        // A rename within one folder: instant, whatever the size of the models.
        match fs::rename(&old, &new) {
            Ok(()) => moved.push(new),
            Err(e) => log(format!("ain: couldn't move {} to {}: {e}", old.display(), new.display())),
        }
    }
    moved
}

/// Moves the old app's folders over. Runs before anything reads or creates the new ones.
pub fn move_data() {
    let bases: Vec<PathBuf> = [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir()].into_iter().flatten().collect();
    move_folders(&bases, |m| eprintln!("{m}"));
}

/// Replaces the old app's launch-at-login entry with AiN's, so the setting stays as it was.
pub fn move_autostart<R: Runtime>(app: &AppHandle<R>) {
    let Ok(exe) = std::env::current_exe() else { return };
    let old = auto_launch::AutoLaunchBuilder::new().set_app_name(OLD_NAME).set_app_path(&exe.display().to_string()).build();
    let Ok(old) = old else { return };
    if !old.is_enabled().unwrap_or(false) {
        return;
    }
    if let Err(e) = old.disable() {
        eprintln!("ain: couldn't remove the old launch-at-login entry: {e}");
        return;
    }
    if let Err(e) = app.autolaunch().enable() {
        eprintln!("ain: couldn't register launching at login: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty folder for one test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ain-renamed-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn identifier_matches_the_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], NEW_ID);
        assert_eq!(conf["productName"], "AiN");
    }

    #[test]
    fn moves_the_old_folder_with_everything_in_it() {
        let base = scratch("moves");
        fs::create_dir_all(base.join(OLD_ID).join("models/parakeet")).unwrap();
        fs::write(base.join(OLD_ID).join("settings.json"), "{}").unwrap();
        assert_eq!(move_folders(std::slice::from_ref(&base), |m| panic!("{m}")), vec![base.join(NEW_ID)]);
        assert!(!base.join(OLD_ID).exists());
        assert_eq!(fs::read_to_string(base.join(NEW_ID).join("settings.json")).unwrap(), "{}");
        assert!(base.join(NEW_ID).join("models/parakeet").is_dir());
    }

    #[test]
    fn leaves_everything_alone_once_the_new_folder_exists() {
        let base = scratch("exists");
        fs::create_dir_all(base.join(OLD_ID)).unwrap();
        fs::create_dir_all(base.join(NEW_ID)).unwrap();
        fs::write(base.join(NEW_ID).join("settings.json"), "new").unwrap();
        assert!(move_folders(std::slice::from_ref(&base), |m| panic!("{m}")).is_empty());
        assert_eq!(fs::read_to_string(base.join(NEW_ID).join("settings.json")).unwrap(), "new");
        assert!(base.join(OLD_ID).exists());
    }

    #[test]
    fn does_nothing_without_an_old_folder() {
        let base = scratch("fresh");
        assert!(move_folders(std::slice::from_ref(&base), |m| panic!("{m}")).is_empty());
        assert!(!base.join(NEW_ID).exists());
    }

    #[test]
    fn moves_each_folder_once_when_two_bases_are_the_same() {
        let base = scratch("same");
        fs::create_dir_all(base.join(OLD_ID)).unwrap();
        assert_eq!(move_folders(&[base.clone(), base.clone()], |m| panic!("{m}")).len(), 1);
    }
}
