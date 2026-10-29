//! Commands on global shortcuts, shown in a small focusable popup: the island as a multi-tool.
//! For example clipboard history on Win+Shift+B, pasting the chosen item into the app you were in.
//!
//! The frontend owns which commands exist and their shortcuts (they live in settings); this plugin
//! registers them, shows the popup for whichever fires, and does the paste (`windows.rs`,
//! `linux.rs`). On Wayland, which lets no app grab keys, the desktop portal binds the
//! shortcuts instead (`portal.rs`).

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod portal;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as os;
#[cfg(windows)]
use windows as os;

/// Elsewhere, the item is only copied.
#[cfg(not(any(windows, target_os = "linux")))]
mod os {
    pub fn foreground() -> Option<isize> {
        None
    }
    pub fn paste_into(_previous: Option<isize>) {}
}

#[cfg(target_os = "linux")]
use std::sync::OnceLock;

/// Presses the paste shortcut in whichever app has the focus.
#[cfg(not(target_os = "linux"))]
pub fn paste_now() {
    os::paste_into(None);
}

use std::{collections::BTreeMap, sync::Mutex, thread, time::Duration};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry, plugin::TauriPlugin,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_specta::Event;

use super::capture;
use crate::Res;

pub const WINDOW: &str = "popup";
/// Full-screen window over a fresh capture, for "screen" commands.
pub const OVERLAY: &str = "overlay";
/// Lets the compositor remove a visible overlay before the next capture.
const OVERLAY_GONE: Duration = Duration::from_millis(150);
/// How long a capture may wait: on Wayland the desktop can first ask the user, with no time limit.
const CAPTURE_WAIT: Duration = Duration::from_secs(60);
const SIZE: LogicalSize<f64> = LogicalSize { width: 460.0, height: 440.0 };
/// The popup sits this far down its monitor, like a launcher.
const TOP: f64 = 0.22;

#[derive(Default)]
struct Popup {
    /// Command id → why its shortcut couldn't be registered.
    failures: Mutex<BTreeMap<String, String>>,
    /// The window that had focus before the popup, to paste into.
    previous: Mutex<Option<isize>>,
    /// The token the desktop sent with the last shortcut, which a window it shows needs to get the
    /// focus on Wayland; used once.
    #[cfg(target_os = "linux")]
    token: Mutex<Option<String>>,
    /// Each bound command's surface, for the shortcuts the portal reports.
    #[cfg(target_os = "linux")]
    surfaces: Mutex<BTreeMap<String, Surface>>,
    #[cfg(target_os = "linux")]
    portal: OnceLock<Option<portal::Portal>>,
}

/// Sent to the popup or the overlay with the command to show.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct Shown {
    command: String,
}

/// Broadcast after shortcuts are (re)bound: command id → why its shortcut failed.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct BindingsChanged(BTreeMap<String, String>);

/// Where a command shows up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    /// The small launcher-style popup.
    Popup,
    /// A capture of the screen under the pointer, shown full-screen.
    Screen,
    /// No window: the plugin that owns the command acts on it, and hears the key's release too
    /// (for "hold to talk").
    Action,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ActionKind {
    Press,
    Release,
    /// Run from the settings page rather than the keyboard: there will be no release.
    Tap,
}

/// Broadcast (to the backend too) when an "action" command's shortcut is pressed or released.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct Action {
    pub command: String,
    pub kind: ActionKind,
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct Binding {
    shortcut: String,
    surface: Surface,
    /// What the command does, for the desktop's own list of shortcuts (on Wayland).
    #[cfg_attr(not(target_os = "linux"), expect(dead_code, reason = "only the Wayland portal shows it"))]
    label: String,
}

/// Runs a command: the popup at once, a capture (off the main thread) then the overlay, or an action.
fn trigger(app: &AppHandle, command: &str, surface: Surface, kind: ActionKind) {
    match surface {
        Surface::Action => {
            let _ = Action { command: command.into(), kind }.emit(app);
        }
        Surface::Popup => {
            let _ = show(app, command);
        }
        Surface::Screen => {
            let (app, command) = (app.clone(), command.to_string());
            thread::spawn(move || {
                if let Err(e) = capture(&app, &command) {
                    eprintln!("island: capture failed: {e}");
                }
            });
        }
    }
}

#[cfg(target_os = "linux")]
fn wayland() -> bool {
    crate::platform::linux::wayland()
}

#[cfg(not(target_os = "linux"))]
fn wayland() -> bool {
    false
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Explains a registration failure in user terms.
pub fn reason(error: &str) -> String {
    if error.contains("AlreadyRegistered") || error.contains("already registered") || error.contains("FailedToRegister") {
        "Already used by Windows or another app".into()
    } else if error.contains("parse") || error.contains("Unrecognized") || error.contains("invalid") {
        "Not a valid shortcut".into()
    } else {
        error.into()
    }
}

/// Registers `bindings` (command id → shortcut and surface), replacing earlier ones; returns those that failed.
#[tauri::command]
#[specta::specta]
async fn bind(app: AppHandle, popup: State<'_, Popup>, bindings: BTreeMap<String, Binding>) -> Res<BTreeMap<String, String>> {
    #[cfg(target_os = "linux")]
    if portal::wanted() {
        *lock(&popup.surfaces) = bindings.iter().map(|(id, b)| (id.clone(), b.surface)).collect();
        let failures = through_portal(&app, bindings).await?;
        *lock(&popup.failures) = failures.clone();
        BindingsChanged(failures.clone()).emit(&app)?;
        return Ok(failures);
    }
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let mut failures = BTreeMap::new();
    for (command, Binding { shortcut, surface, .. }) in bindings {
        let id = command.clone();
        let result = shortcuts.on_shortcut(shortcut.as_str(), move |app, _, event| match event.state {
            ShortcutState::Pressed => trigger(app, &id, surface, ActionKind::Press),
            ShortcutState::Released if surface == Surface::Action => trigger(app, &id, surface, ActionKind::Release),
            ShortcutState::Released => {}
        });
        if let Err(e) = result {
            failures.insert(command, reason(&format!("{e:?} {e}")));
        }
    }
    *lock(&popup.failures) = failures.clone();
    BindingsChanged(failures.clone()).emit(&app)?;
    Ok(failures)
}

/// Binds the shortcuts through the desktop portal, started the first time; blocks (off the async
/// runtime) while the desktop asks the user to confirm them.
#[cfg(target_os = "linux")]
async fn through_portal(app: &AppHandle, bindings: BTreeMap<String, Binding>) -> Res<BTreeMap<String, String>> {
    let shortcuts: Vec<portal::Shortcut> =
        bindings.into_iter().map(|(id, b)| portal::Shortcut { id, description: b.label, trigger: portal::trigger(&b.shortcut) }).collect();
    let app = app.clone();
    let failures = tauri::async_runtime::spawn_blocking(move || {
        let popup = app.state::<Popup>();
        let started = popup.portal.get_or_init(|| {
            let handle = app.clone();
            portal::Portal::start(app.config().identifier.clone(), move |event| on_portal(&handle, event))
                .inspect_err(|e| eprintln!("island: shortcuts: {e}"))
                .ok()
        });
        match started {
            Some(portal) => portal.bind(shortcuts),
            None => shortcuts.into_iter().map(|s| (s.id, "The desktop's shortcut service couldn't start".into())).collect(),
        }
    })
    .await
    .map_err(|e| crate::Error::msg(e.to_string()))?;
    Ok(failures)
}

/// A shortcut the portal reports: run as the X11 grab would, its token kept for the window it shows.
#[cfg(target_os = "linux")]
fn on_portal(app: &AppHandle, event: portal::Event) {
    let popup = app.state::<Popup>();
    let (id, kind, token) = match event {
        portal::Event::Pressed { id, token } => (id, ActionKind::Press, token),
        portal::Event::Released { id } => (id, ActionKind::Release, None),
    };
    let Some(surface) = lock(&popup.surfaces).get(&id).copied() else { return };
    if kind == ActionKind::Press {
        *lock(&popup.token) = token;
        trigger(app, &id, surface, kind);
    } else if surface == Surface::Action {
        trigger(app, &id, surface, kind);
    }
}

/// Shows `window` and gives it the focus. On Wayland the desktop only hands the focus over with
/// the token of the shortcut that asked for the window, which this uses up.
pub fn focus(app: &AppHandle, window: &WebviewWindow) -> Res<()> {
    #[cfg(target_os = "linux")]
    if let Some(token) = app.try_state::<Popup>().and_then(|p| lock(&p.token).take()) {
        let target = window.clone();
        app.run_on_main_thread(move || {
            use gtk::prelude::GtkWindowExt;
            if let Ok(gtk) = target.gtk_window() {
                gtk.set_startup_id(&token);
            }
        })?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Shortcuts that couldn't be registered at the last `bind`.
#[tauri::command]
#[specta::specta]
fn failures(popup: State<'_, Popup>) -> BTreeMap<String, String> {
    lock(&popup.failures).clone()
}

/// Async so the window is created off the IPC callback.
#[tauri::command]
#[specta::specta]
async fn open(app: AppHandle, command: String, surface: Surface) -> Res<()> {
    trigger(&app, &command, surface, ActionKind::Tap);
    Ok(())
}

/// Hides the window that asks (the popup or the overlay).
#[tauri::command]
#[specta::specta]
fn hide(window: WebviewWindow) -> Res<()> {
    window.hide()?;
    Ok(())
}

/// Hides the asking window, gives focus back to the previous app and pastes (Ctrl+V) into
/// it. Async: it waits briefly for focus to settle, off the main thread.
#[tauri::command]
#[specta::specta]
async fn paste(window: WebviewWindow, popup: State<'_, Popup>) -> Res<()> {
    window.hide()?;
    let previous = lock(&popup.previous).take();
    os::paste_into(previous);
    Ok(())
}

/// Shows the popup for `command` on the monitor under the pointer, remembering who had focus.
pub fn show(app: &AppHandle, command: &str) -> Res<()> {
    if let Some(foreground) = os::foreground() {
        *lock(&app.state::<Popup>().previous) = Some(foreground);
    }
    let window = match app.get_webview_window(WINDOW) {
        Some(w) => w,
        None => WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App(format!("popup.html#{command}").into()))
            .title("AiN")
            .inner_size(SIZE.width, SIZE.height)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()?,
    };
    if let Some(m) = app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten()).or(window.current_monitor()?)
    {
        let scale = m.scale_factor();
        let (origin, area) = (m.position().to_logical::<f64>(scale), m.size().to_logical::<f64>(scale));
        window.set_position(LogicalPosition::new(origin.x + (area.width - SIZE.width) / 2.0, origin.y + area.height * TOP))?;
    }
    Shown { command: command.into() }.emit(app)?;
    focus(app, &window)
}

/// Captures the monitor under the pointer, then covers it with the overlay showing that capture.
fn capture(app: &AppHandle, command: &str) -> Res<()> {
    let pointer = app.cursor_position()?;
    // Nothing of ours may be in the capture: an earlier overlay, or the command palette that ran this.
    let shown: Vec<WebviewWindow> =
        [OVERLAY, WINDOW].iter().filter_map(|label| app.get_webview_window(label)).filter(|w| w.is_visible().unwrap_or(false)).collect();
    for window in &shown {
        window.hide()?;
    }
    if !shown.is_empty() {
        thread::sleep(OVERLAY_GONE);
    }
    *lock(&app.state::<Popup>().previous) = os::foreground();
    let (x, y) = (pointer.x as i32, pointer.y as i32);
    let (origin, size) = match crate::platform::within(CAPTURE_WAIT, move || capture::capture_at(x, y)) {
        Some(Ok(shot)) => {
            let place = (shot.origin, shot.size);
            capture::store(app, shot);
            place
        }
        failed => {
            let error = failed.and_then(Result::err).map(|e| e.to_string());
            eprintln!("island: capture failed: {}", error.as_deref().unwrap_or("no answer in time"));
            capture::store_problem(app, capture::explain(error.as_deref(), wayland()));
            // The overlay still opens over the monitor under the pointer, to say why.
            let monitor = app.monitor_from_point(pointer.x, pointer.y)?.or(app.primary_monitor()?);
            let monitor = monitor.ok_or_else(|| crate::Error::msg("no monitor to show the overlay on"))?;
            (*monitor.position(), *monitor.size())
        }
    };
    let window = match app.get_webview_window(OVERLAY) {
        Some(w) => w,
        None => WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App(format!("overlay.html#{command}").into()))
            .title("AiN capture")
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()?,
    };
    window.set_position(origin)?;
    window.set_size(size)?;
    Shown { command: command.into() }.emit(app)?;
    focus(app, &window)
}

crate::ipc::popup!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        app.manage(Popup::default());
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explains_failures_in_user_terms() {
        assert_eq!(reason("AlreadyRegistered(HotKey { .. })"), "Already used by Windows or another app");
        assert_eq!(reason("FailedToRegister(\"Super+B\")"), "Already used by Windows or another app");
        assert_eq!(reason("Unrecognized hotkey key"), "Not a valid shortcut");
    }
}
