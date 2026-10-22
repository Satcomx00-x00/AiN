//! GNOME on Wayland lets no app move another's windows, nor see the pointer outside its own. AiN's
//! GNOME Shell extension (`gnome/extension.js`, installed from Settings) does both for zones, over
//! D-Bus: it names the window the user is in, says when one is being moved (and only then is the
//! pointer asked for), and moves windows where zones ask.

use std::{
    fs, io,
    path::PathBuf,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use dbus::{
    arg::{AppendAll, ReadAll},
    blocking::Connection,
    message::MatchRule,
};

use super::{Desktop, Handle, Pointer, Rect};

pub const UUID: &str = "ain-zones@satcom.dev";
const NAME: &str = "dev.satcom.AiN.Zones";
const PATH: &str = "/dev/satcom/AiN/Zones";
const INTERFACE: &str = "dev.satcom.AiN.Zones";
/// The interface version this build speaks; an older helper is replaced, a newer one used as is.
const VERSION: u32 = 1;
const TIMEOUT: Duration = Duration::from_millis(500);
/// Clutter's modifier bits, as the extension reports them.
const SHIFT: u32 = 1 << 0;
const CONTROL: u32 = 1 << 2;

const EXTENSION: &str = include_str!("gnome/extension.js");
const METADATA: &str = include_str!("gnome/metadata.json");

/// Whether this is a GNOME session.
pub fn session() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|d| d.split(':').any(|d| d.eq_ignore_ascii_case("gnome")))
}

/// Where GNOME Shell finds the user's extensions.
fn folder() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("gnome-shell").join("extensions").join(UUID))
}

/// How far the helper is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Helper {
    /// Not installed.
    Missing,
    /// Installed, but GNOME Shell only loads it at the next login.
    Waiting,
    Running,
}

/// GNOME Shell's string lists, as `gsettings` prints them: `['a', 'b']`, or `@as []` when empty.
fn parse_list(text: &str) -> Vec<String> {
    text.split('\'').skip(1).step_by(2).map(str::to_string).collect()
}

fn format_list(items: &[String]) -> String {
    format!("[{}]", items.iter().map(|i| format!("'{i}'")).collect::<Vec<_>>().join(", "))
}

fn gsettings(args: &[&str]) -> io::Result<String> {
    let out = Command::new("gsettings").args(args).output()?;
    match out.status.success() {
        true => Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        false => Err(io::Error::other(String::from_utf8_lossy(&out.stderr).trim().to_string())),
    }
}

/// Writes the extension where GNOME Shell finds it and turns it on; GNOME starts it at the next login.
pub fn install() -> io::Result<()> {
    let folder = folder().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no data folder"))?;
    fs::create_dir_all(&folder)?;
    fs::write(folder.join("extension.js"), EXTENSION)?;
    fs::write(folder.join("metadata.json"), METADATA)?;
    let mut enabled = parse_list(&gsettings(&["get", "org.gnome.shell", "enabled-extensions"])?);
    if !enabled.iter().any(|e| e == UUID) {
        enabled.push(UUID.into());
        gsettings(&["set", "org.gnome.shell", "enabled-extensions", &format_list(&enabled)])?;
    }
    Ok(())
}

/// Brings an installed helper up to this build's version (it takes over at the next login).
pub fn refresh() {
    let Some(file) = folder().map(|f| f.join("extension.js")) else { return };
    if fs::read_to_string(&file).is_ok_and(|current| current != EXTENSION) {
        let _ = install();
    }
}

/// The helper on the session bus, and whether a window is being moved.
pub struct Gnome {
    conn: Connection,
    moving: Arc<AtomicBool>,
}

impl Gnome {
    pub fn open() -> Option<Self> {
        let conn = Connection::new_session().ok()?;
        let moving = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&moving);
        let rule = MatchRule::new_signal(INTERFACE, "MovingChanged").with_path(PATH);
        conn.add_match(rule, move |(value,): (bool,), _, _| {
            flag.store(value, Ordering::Relaxed);
            true
        })
        .ok()?;
        Some(Self { conn, moving })
    }

    fn call<R: ReadAll, A: AppendAll>(&self, method: &str, args: A) -> Result<R, dbus::Error> {
        self.conn.with_proxy(NAME, PATH, TIMEOUT).method_call(INTERFACE, method, args)
    }

    /// How far the helper is: answering, installed, or neither.
    pub fn helper(&self) -> Helper {
        match self.call::<(u32,), _>("Version", ()) {
            Ok((version,)) if version >= VERSION => Helper::Running,
            _ if folder().is_some_and(|f| f.join("extension.js").is_file()) => Helper::Waiting,
            _ => Helper::Missing,
        }
    }
}

impl Desktop for Gnome {
    fn pointer(&mut self) -> Option<Pointer> {
        // Signals waiting: a move that began or ended.
        while self.conn.process(Duration::ZERO).unwrap_or(false) {}
        if !self.moving.load(Ordering::Relaxed) {
            return Some(Pointer::default());
        }
        let (x, y, modifiers): (i32, i32, u32) = self.call("Pointer", ()).ok()?;
        Some(Pointer { x, y, pressed: true, shift: modifiers & SHIFT != 0, ctrl: modifiers & CONTROL != 0 })
    }

    fn focused(&mut self) -> Option<Handle> {
        let (window,): (u64,) = self.call("Focused", (std::process::id(),)).ok()?;
        (window != 0).then_some(window as Handle)
    }

    fn frame(&mut self, window: Handle) -> Option<Rect> {
        let (found, x, y, w, h): (bool, i32, i32, i32, i32) = self.call("Frame", (window as u64,)).ok()?;
        found.then_some(Rect::new(x, y, w, h))
    }

    fn place(&mut self, window: Handle, to: Rect) -> Result<(), String> {
        let (placed,): (bool,) = self.call("Place", (window as u64, to.x, to.y, to.w, to.h)).map_err(|e| e.to_string())?;
        if placed { Ok(()) } else { Err("the window can't be moved".into()) }
    }

    fn activate(&mut self, window: Handle) {
        let _: Result<(), _> = self.call("Activate", (window as u64,));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_writes_gnome_shell_string_lists() {
        assert_eq!(parse_list("['a@b', 'appindicatorsupport@rgcjonas.gmail.com']"), ["a@b", "appindicatorsupport@rgcjonas.gmail.com"]);
        assert!(parse_list("@as []").is_empty());
        assert_eq!(format_list(&["a@b".into(), UUID.into()]), "['a@b', 'ain-zones@satcom.dev']");
        assert_eq!(format_list(&[]), "[]");
    }

    #[test]
    fn ships_an_extension_for_the_gnome_versions_it_was_written_for() {
        let metadata: serde_json::Value = serde_json::from_str(METADATA).unwrap();
        assert_eq!(metadata["uuid"], UUID);
        let versions: Vec<&str> = metadata["shell-version"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert!(versions.contains(&"50"), "GNOME 50, as Fedora 44 has");
        assert!(EXTENSION.contains(&format!("const VERSION = {VERSION};")), "the extension and this build speak the same version");
        assert!(EXTENSION.contains(NAME) && EXTENSION.contains(PATH));
    }

    /// Against a running GNOME Shell with the helper enabled and a window focused:
    /// `AIN_GNOME_TEST=1 cargo test gnome -- --ignored`.
    #[test]
    #[ignore]
    fn moves_the_focused_window_through_gnome_shell() {
        let mut gnome = Gnome::open().expect("session bus");
        assert_eq!(gnome.helper(), Helper::Running);
        let window = gnome.focused().expect("a focused window");
        gnome.place(window, Rect::new(50, 70, 640, 480)).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(gnome.frame(window), Some(Rect::new(50, 70, 640, 480)));
        assert_eq!(gnome.pointer().map(|p| p.pressed), Some(false), "nothing is being moved");
    }
}
