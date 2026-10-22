//! macOS: apps are the bundles in the Applications folders, opened with `open`; commands run in
//! Terminal; system actions go through `pmset`, System Events and the Finder.

use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

use super::{App, SystemAction};
use crate::platform::{detached, macos::keys};

/// The app bundle to open.
pub struct Launch(PathBuf);

const FOLDERS: &[&str] = &["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"];
/// Apps that live outside the Applications folders.
const ALSO: &[&str] = &["/System/Library/CoreServices/Finder.app"];

fn is_app(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "app")
}

/// The bundles in `dir`, and in the folders of apps it holds ("Microsoft Office/Word.app").
fn bundles(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if is_app(&path) {
            out.push(path);
        } else if entry.file_type().is_ok_and(|t| t.is_dir()) && !entry.file_name().to_string_lossy().starts_with('.') {
            out.extend(fs::read_dir(&path).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| is_app(p)));
        }
    }
}

pub fn apps() -> Vec<(App, Launch)> {
    let mut found = Vec::new();
    let user = dirs::home_dir().map(|h| h.join("Applications"));
    for dir in FOLDERS.iter().map(PathBuf::from).chain(user) {
        bundles(&dir, &mut found);
    }
    found.extend(ALSO.iter().map(PathBuf::from).filter(|p| p.exists()));
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .filter_map(|path| {
            let name = path.file_stem()?.to_string_lossy().into_owned();
            let detail = path.parent().map(|p| p.display().to_string()).unwrap_or_default();
            Some((App { id: path.display().to_string(), name, keywords: String::new(), detail }, Launch(path)))
        })
        .collect()
}

pub fn launch(launch: &Launch) -> io::Result<()> {
    let mut open = Command::new("open");
    open.arg(&launch.0);
    detached(open)
}

/// `text` as an AppleScript string's content.
fn quoted(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

fn script(lines: &[&str]) -> io::Result<()> {
    let mut osascript = Command::new("osascript");
    for line in lines {
        osascript.args(["-e", line]);
    }
    detached(osascript)
}

/// Runs `command` in a new Terminal window, which stays open after it.
pub fn terminal(command: &str) -> io::Result<()> {
    let run = format!("do script \"{}\"", quoted(command));
    script(&["tell application \"Terminal\"", "activate", &run, "end tell"])
}

pub fn reveal(path: &Path) -> io::Result<()> {
    let mut open = Command::new("open");
    open.arg("-R").arg(path);
    detached(open)
}

pub fn system(action: SystemAction) -> io::Result<()> {
    let pmset = |arg: &str| {
        let mut pmset = Command::new("pmset");
        pmset.arg(arg);
        detached(pmset)
    };
    match action {
        // Control-Command-Q, as the Apple menu's Lock Screen; without Accessibility access, the
        // display sleeps, which locks it when a password is asked on wake.
        SystemAction::Lock if keys::lock_screen() => Ok(()),
        SystemAction::Lock => pmset("displaysleepnow"),
        SystemAction::Sleep => pmset("sleepnow"),
        SystemAction::SignOut => script(&["tell application \"System Events\" to log out"]),
        SystemAction::Restart => script(&["tell application \"System Events\" to restart"]),
        SystemAction::ShutDown => script(&["tell application \"System Events\" to shut down"]),
        SystemAction::EmptyTrash => script(&["tell application \"Finder\" to empty trash"]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_commands_for_applescript() {
        assert_eq!(quoted(r#"echo "hi" \ there"#), r#"echo \"hi\" \\ there"#);
    }

    #[test]
    fn finds_bundles_and_folders_of_bundles() {
        let root = std::env::temp_dir().join(format!("ain-mac-apps-{}", std::process::id()));
        for dir in ["Notes.app/Contents", "Office/Word.app", "Office/Readme", ".hidden/Secret.app"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let mut found = Vec::new();
        bundles(&root, &mut found);
        let mut names: Vec<String> = found.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        names.sort();
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(names, ["Notes.app", "Word.app"]);
    }
}
