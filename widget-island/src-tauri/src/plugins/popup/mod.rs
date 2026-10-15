//! Commands on global shortcuts, shown in a small focusable popup: the island as a multi-tool.
//! For example clipboard history on Win+Shift+B, pasting the chosen item into the app you were in.
//!
//! The frontend owns which commands exist and their shortcuts (they live in settings); this plugin
//! registers them, shows the popup for whichever fires, and does the paste.

#[cfg(windows)]
mod windows;

use std::{collections::BTreeMap, sync::Mutex, thread, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    plugin::{Builder, TauriPlugin},
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use super::screen;
use crate::Res;

pub const WINDOW: &str = "popup";
/// Full-screen window over a fresh capture, for "screen" commands.
pub const OVERLAY: &str = "overlay";
/// Lets the compositor remove a visible overlay before the next capture.
const OVERLAY_GONE: Duration = Duration::from_millis(150);
/// Sent to the popup with the command to show.
pub const SHOW_EVENT: &str = "popup:show";
/// Broadcast (to the backend too) when an "action" command's shortcut is pressed or released.
pub const ACTION_EVENT: &str = "command:action";
/// Broadcast after shortcuts are (re)bound, with the ones that failed.
pub const BINDINGS_EVENT: &str = "popup:bindings";
const SIZE: LogicalSize<f64> = LogicalSize { width: 460.0, height: 440.0 };
/// The popup sits this far down its monitor, like a launcher.
const TOP: f64 = 0.22;

#[derive(Default)]
struct Popup {
    /// Command id → why its shortcut couldn't be registered.
    failures: Mutex<BTreeMap<String, String>>,
    /// The window that had focus before the popup, to paste into.
    previous: Mutex<Option<isize>>,
}

#[derive(Debug, Clone, Serialize)]
struct Show {
    command: String,
}

/// Where a command shows up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionKind {
    Press,
    Release,
    /// Run from the settings page rather than the keyboard: there will be no release.
    Tap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    pub command: String,
    pub kind: ActionKind,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Binding {
    shortcut: String,
    surface: Surface,
}

/// Runs a command: the popup at once, a capture (off the main thread) then the overlay, or an action.
fn trigger<R: Runtime>(app: &AppHandle<R>, command: &str, surface: Surface, kind: ActionKind) {
    match surface {
        Surface::Action => {
            let _ = app.emit(ACTION_EVENT, Action { command: command.into(), kind });
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
async fn bind<R: Runtime>(
    app: AppHandle<R>,
    popup: State<'_, Popup>,
    bindings: BTreeMap<String, Binding>,
) -> Res<BTreeMap<String, String>> {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let mut failures = BTreeMap::new();
    for (command, Binding { shortcut, surface }) in bindings {
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
    app.emit(BINDINGS_EVENT, &failures)?;
    Ok(failures)
}

/// Shortcuts that couldn't be registered at the last `bind`.
#[tauri::command]
fn failures(popup: State<'_, Popup>) -> BTreeMap<String, String> {
    lock(&popup.failures).clone()
}

/// Async so the window is created off the IPC callback.
#[tauri::command]
async fn open<R: Runtime>(app: AppHandle<R>, command: String, surface: Surface) -> Res<()> {
    trigger(&app, &command, surface, ActionKind::Tap);
    Ok(())
}

/// Hides the window that asks (the popup or the overlay).
#[tauri::command]
fn hide<R: Runtime>(window: WebviewWindow<R>) -> Res<()> {
    window.hide()?;
    Ok(())
}

/// Hides the asking window, gives focus back to the previous app and pastes (Ctrl+V) into it.
/// Async: it waits briefly for focus to settle, off the main thread.
#[tauri::command]
async fn paste<R: Runtime>(window: WebviewWindow<R>, popup: State<'_, Popup>) -> Res<()> {
    window.hide()?;
    let previous = lock(&popup.previous).take();
    #[cfg(windows)]
    windows::paste_into(previous);
    #[cfg(not(windows))]
    let _ = previous;
    Ok(())
}

/// Shows the popup for `command` on the monitor under the pointer, remembering who had focus.
pub fn show<R: Runtime>(app: &AppHandle<R>, command: &str) -> Res<()> {
    #[cfg(windows)]
    {
        let foreground = windows::foreground();
        let ours = app.get_webview_window(WINDOW).and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
        if foreground.is_some() && foreground != ours {
            *lock(&app.state::<Popup>().previous) = foreground;
        }
    }
    let window = match app.get_webview_window(WINDOW) {
        Some(w) => w,
        None => WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App(format!("popup.html#{command}").into()))
            .title("Island")
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
    window.emit(SHOW_EVENT, Show { command: command.into() })?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Captures the monitor under the pointer, then covers it with the overlay showing that capture.
fn capture<R: Runtime>(app: &AppHandle<R>, command: &str) -> Res<()> {
    let pointer = app.cursor_position()?;
    if let Some(w) = app.get_webview_window(OVERLAY).filter(|w| w.is_visible().unwrap_or(false)) {
        w.hide()?;
        thread::sleep(OVERLAY_GONE);
    }
    #[cfg(windows)]
    {
        *lock(&app.state::<Popup>().previous) = windows::foreground();
    }
    let shot = screen::capture_at(pointer.x as i32, pointer.y as i32)?;
    let (origin, size) = (shot.origin, shot.size);
    screen::store(app, shot);
    let window = match app.get_webview_window(OVERLAY) {
        Some(w) => w,
        None => WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App(format!("overlay.html#{command}").into()))
            .title("Island capture")
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
    window.emit(SHOW_EVENT, Show { command: command.into() })?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("popup")
        .invoke_handler(tauri::generate_handler![bind, failures, open, hide, paste])
        .setup(|app, _| {
            app.manage(Popup::default());
            Ok(())
        })
        .build()
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
