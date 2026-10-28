//! `ain --cleanup [--purge]`: undoes what the app set up outside its own files, then exits without
//! opening a window. Package managers can't run code on removal (npm and bun skip uninstall scripts),
//! so the npm package's `ain uninstall` calls this before removing the app.
//!
//! - always: the launch-at-login entry, which would otherwise point at a deleted file;
//! - with `--purge`: the settings, plugins and downloaded speech models too.

use std::{fs, path::PathBuf};

use crate::shell::renamed::NEW_ID;

pub const CLEANUP: &str = "--cleanup";
pub const PURGE: &str = "--purge";
/// The name launching at login is registered under: `productName` in `tauri.conf.json`, which
/// `tauri-plugin-autostart` uses.
const AUTOSTART_NAME: &str = "AiN";

/// What the command line asks for, if it asks for a cleanup.
#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub purge: bool,
}

impl Request {
    pub fn parse<S: AsRef<str>>(args: impl IntoIterator<Item = S>) -> Option<Self> {
        let args: Vec<S> = args.into_iter().collect();
        let has = |flag: &str| args.iter().any(|a| a.as_ref() == flag);
        has(CLEANUP).then(|| Self { purge: has(PURGE) })
    }
}

/// The app's own folders: `<base>/dev.satcom.ain` for each base, once each.
pub fn data_folders(bases: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = bases.into_iter().map(|b| b.join(NEW_ID)).collect();
    folders.sort();
    folders.dedup();
    folders.retain(|f| f.is_dir());
    folders
}

/// Runs the cleanup; returns the process exit code (non-zero when something couldn't be removed).
pub fn run(request: &Request) -> i32 {
    let mut failed = false;
    let autostart = auto_launch::AutoLaunchBuilder::new()
        .set_app_name(AUTOSTART_NAME)
        // Removal goes by name; the path only has to be set.
        .set_app_path(&std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default())
        .build();
    match autostart {
        Ok(entry) if entry.is_enabled().unwrap_or(false) => match entry.disable() {
            Ok(()) => println!("ain: removed launching at login"),
            Err(e) => {
                eprintln!("ain: couldn't remove launching at login: {e}");
                failed = true;
            }
        },
        Ok(_) => {}
        Err(e) => {
            eprintln!("ain: couldn't read launching at login: {e}");
            failed = true;
        }
    }
    if request.purge {
        let bases = [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir(), dirs::cache_dir()];
        for folder in data_folders(bases.into_iter().flatten()) {
            match fs::remove_dir_all(&folder) {
                Ok(()) => println!("ain: removed {}", folder.display()),
                Err(e) => {
                    eprintln!("ain: couldn't remove {}: {e}", folder.display());
                    failed = true;
                }
            }
        }
    }
    i32::from(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_flags() {
        assert_eq!(Request::parse(["ain"]), None);
        assert_eq!(Request::parse(["ain", "--purge"]), None, "purge alone isn't a cleanup");
        assert_eq!(Request::parse(["ain", "--cleanup"]), Some(Request { purge: false }));
        assert_eq!(Request::parse(["ain", "--purge", "--cleanup"]), Some(Request { purge: true }));
    }

    #[test]
    fn finds_each_existing_folder_once() {
        let base = std::env::temp_dir().join(format!("ain-cleanup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (with, without) = (base.join("with"), base.join("without"));
        fs::create_dir_all(with.join(NEW_ID)).unwrap();
        fs::create_dir_all(&without).unwrap();
        // Windows keeps config and data in the same base.
        let found = data_folders([with.clone(), with.clone(), without]);
        assert_eq!(found, vec![with.join(NEW_ID)]);
        fs::remove_dir_all(&base).unwrap();
    }
}
