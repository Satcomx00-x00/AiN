//! Linux: apps are the desktop entries of the freedesktop.org menu (system, user, Flatpak and
//! Snap ones), started as their `Exec` line says; commands run in the first terminal found;
//! system actions go through logind, the desktop's session manager and GLib.

use std::{
    collections::HashSet,
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use super::{App, SystemAction, desktop};
use crate::platform::{detached, on_path};

/// How deep desktop entries are looked for under an `applications` folder.
const SUBFOLDERS: usize = 3;

pub struct Launch {
    argv: Vec<String>,
    terminal: bool,
    dir: Option<PathBuf>,
}

/// Terminals and how each takes the command to run after its own arguments, most standard first.
const TERMINALS: &[(&str, &[&str])] = &[
    ("xdg-terminal-exec", &[]),
    ("kgx", &["--"]),
    ("gnome-terminal", &["--"]),
    ("konsole", &["-e"]),
    ("xfce4-terminal", &["-x"]),
    ("mate-terminal", &["-x"]),
    ("ptyxis", &["--"]),
    ("alacritty", &["-e"]),
    ("kitty", &[]),
    ("foot", &[]),
    ("wezterm", &["start", "--"]),
    ("ghostty", &["-e"]),
    ("x-terminal-emulator", &["-e"]),
    ("xterm", &["-e"]),
];

fn non_empty(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.is_empty())
}

/// The folders holding desktop entries, in the order the menu reads them: the user's first.
fn folders(home: Option<&Path>) -> Vec<PathBuf> {
    let data_home = non_empty("XDG_DATA_HOME").map(PathBuf::from).or_else(|| home.map(|h| h.join(".local/share")));
    let data_dirs = non_empty("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    // Flatpak and Snap apps, should the session not list their folders.
    let extra = [home.map(|h| h.join(".local/share/flatpak/exports/share"))]
        .into_iter()
        .flatten()
        .chain(["/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop"].map(PathBuf::from));
    let mut out = Vec::new();
    for dir in data_home.into_iter().chain(data_dirs.split(':').filter(|d| !d.is_empty()).map(PathBuf::from)).chain(extra) {
        let dir = dir.join("applications");
        if !out.contains(&dir) {
            out.push(dir);
        }
    }
    out
}

/// The `.desktop` files under `dir`, with their desktop file ids ("org.gnome.Nautilus.desktop";
/// a subfolder's name is joined with a dash), at most `depth` folders down.
fn entries(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<(String, PathBuf)>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let (path, name) = (entry.path(), entry.file_name().to_string_lossy().into_owned());
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            if depth > 0 {
                entries(&path, &format!("{prefix}{name}-"), depth - 1, out);
            }
        } else if name.ends_with(".desktop") {
            out.push((format!("{prefix}{name}"), path));
        }
    }
}

pub fn apps() -> Vec<(App, Launch)> {
    let home = dirs::home_dir();
    let lang = non_empty("LC_ALL").or_else(|| non_empty("LC_MESSAGES")).or_else(|| non_empty("LANG")).unwrap_or_default();
    let locales = desktop::locales(&lang);
    let desktops: Vec<String> = non_empty("XDG_CURRENT_DESKTOP").unwrap_or_default().split(':').map(str::to_string).collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for folder in folders(home.as_deref()) {
        let mut found = Vec::new();
        entries(&folder, "", SUBFOLDERS, &mut found);
        for (id, path) in found {
            // The first folder with an id wins, as menus do: a hidden user entry hides the system's.
            if !seen.insert(id) {
                continue;
            }
            let Some(entry) = fs::read_to_string(&path).ok().and_then(|text| desktop::parse(&text, &locales)) else { continue };
            if !entry.shown(&desktops) || entry.try_exec.as_deref().is_some_and(|program| !on_path(program)) {
                continue;
            }
            let Some(argv) = desktop::argv(&entry.exec, &entry.name, &path) else { continue };
            let keywords = entry.generic.iter().chain(&entry.keywords).cloned().collect::<Vec<_>>().join(" ");
            let detail = entry.comment.or(entry.generic).unwrap_or_default();
            let app = App { id: path.display().to_string(), name: entry.name, keywords, detail };
            out.push((app, Launch { argv, terminal: entry.terminal, dir: entry.path.map(PathBuf::from) }));
        }
    }
    out
}

/// `argv` wrapped to run in a new window of the first terminal found (`$TERMINAL` if set).
fn in_terminal(argv: &[String]) -> io::Result<Vec<String>> {
    let chosen = non_empty("TERMINAL").filter(|t| on_path(t)).map(|t| (t, &["-e"][..]));
    let (program, args) = chosen
        .or_else(|| TERMINALS.iter().find(|(t, _)| on_path(t)).map(|(t, args)| (t.to_string(), *args)))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no terminal is installed"))?;
    Ok([program].into_iter().chain(args.iter().map(|a| a.to_string())).chain(argv.iter().cloned()).collect())
}

fn start(argv: &[String], dir: Option<&Path>) -> io::Result<()> {
    let (program, args) = argv.split_first().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "nothing to start"))?;
    let mut command = Command::new(program);
    command.args(args);
    if let Some(dir) = dir.map(Path::to_path_buf).or_else(dirs::home_dir) {
        command.current_dir(dir);
    }
    detached(command)
}

pub fn launch(launch: &Launch) -> io::Result<()> {
    match launch.terminal {
        true => start(&in_terminal(&launch.argv)?, launch.dir.as_deref()),
        false => start(&launch.argv, launch.dir.as_deref()),
    }
}

/// Runs `command` in the user's shell in a new terminal, then leaves a shell open there.
pub fn terminal(command: &str) -> io::Result<()> {
    let script = format!("{command}\nexec \"${{SHELL:-sh}}\"");
    start(&in_terminal(&["sh".into(), "-c".into(), script])?, None)
}

/// `path` as a `file://` URI, every byte outside the unreserved set percent-encoded.
fn file_uri(path: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    let mut uri = String::from("file://");
    for &b in path.as_os_str().as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => uri.push(b as char),
            _ => uri.push_str(&format!("%{b:02X}")),
        }
    }
    uri
}

fn succeeds(argv: &[&str]) -> bool {
    let Some((program, args)) = argv.split_first() else { return false };
    on_path(program)
        && Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}

/// Shows `path` selected in the file manager, through the FileManager1 interface most implement
/// (Files, Dolphin, Nemo, Thunar…); otherwise opens its folder.
pub fn reveal(path: &Path) -> io::Result<()> {
    let items = format!("['{}']", file_uri(path));
    let shown = succeeds(&[
        "gdbus",
        "call",
        "--session",
        "--dest",
        "org.freedesktop.FileManager1",
        "--object-path",
        "/org/freedesktop/FileManager1",
        "--method",
        "org.freedesktop.FileManager1.ShowItems",
        &items,
        "",
    ]);
    if shown { Ok(()) } else { crate::platform::open_path(path.parent().unwrap_or(path)) }
}

/// The command lines that do `action`, tried in order: the desktop's own first where it has one,
/// then logind's.
fn candidates(action: SystemAction, session: Option<&str>) -> Vec<Vec<String>> {
    let lines: Vec<Vec<&str>> = match action {
        SystemAction::Lock => vec![vec!["loginctl", "lock-session"], vec!["xdg-screensaver", "lock"]],
        SystemAction::Sleep => vec![vec!["systemctl", "suspend"], vec!["loginctl", "suspend"]],
        SystemAction::SignOut => {
            let mut lines = vec![vec!["gnome-session-quit", "--logout", "--no-prompt"], vec!["xfce4-session-logout", "--logout", "--fast"]];
            lines.extend(session.map(|id| vec!["loginctl", "terminate-session", id]));
            lines
        }
        SystemAction::Restart => vec![vec!["systemctl", "reboot"], vec!["loginctl", "reboot"]],
        SystemAction::ShutDown => vec![vec!["systemctl", "poweroff"], vec!["loginctl", "poweroff"]],
        SystemAction::EmptyTrash => vec![vec!["gio", "trash", "--empty"]],
    };
    lines.into_iter().map(|line| line.into_iter().map(String::from).collect()).collect()
}

pub fn system(action: SystemAction) -> io::Result<()> {
    let session = non_empty("XDG_SESSION_ID");
    candidates(action, session.as_deref())
        .iter()
        .any(|argv| succeeds(&argv.iter().map(String::as_str).collect::<Vec<_>>()))
        .then_some(())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no tool on this system could do it"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_paths_as_file_uris() {
        assert_eq!(file_uri(Path::new("/home/me/My Notes/café's.txt")), "file:///home/me/My%20Notes/caf%C3%A9%27s.txt");
    }

    #[test]
    fn reads_desktop_ids_with_their_subfolders() {
        let root = std::env::temp_dir().join(format!("ain-desktop-ids-{}", std::process::id()));
        fs::create_dir_all(root.join("kde")).unwrap();
        fs::write(root.join("firefox.desktop"), "").unwrap();
        fs::write(root.join("kde").join("dolphin.desktop"), "").unwrap();
        fs::write(root.join("notes.txt"), "").unwrap();
        let mut found = Vec::new();
        entries(&root, "", SUBFOLDERS, &mut found);
        let mut ids: Vec<String> = found.into_iter().map(|(id, _)| id).collect();
        ids.sort();
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(ids, ["firefox.desktop", "kde-dolphin.desktop"]);
    }

    #[test]
    fn signs_out_through_the_desktop_then_logind() {
        let lines = candidates(SystemAction::SignOut, Some("c2"));
        assert_eq!(lines.first().map(|l| l[0].as_str()), Some("gnome-session-quit"));
        assert_eq!(lines.last().unwrap(), &["loginctl", "terminate-session", "c2"]);
        assert!(!candidates(SystemAction::SignOut, None).iter().any(|l| l[0] == "loginctl"));
        assert_eq!(candidates(SystemAction::ShutDown, None)[0], ["systemctl", "poweroff"]);
    }
}
