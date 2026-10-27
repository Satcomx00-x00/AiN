//! Handing text to the app in front, shared by dictation and spelling: typed at the cursor
//! (`windows.rs`; on macOS and Linux, the platform's key helpers), which also replaces a selection,
//! or put on the clipboard when the system won't let us type: macOS until the user allows
//! Accessibility access, Wayland without `wtype` or `ydotool`, X11 without `xdotool`.

#[cfg(windows)]
mod windows;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};

use super::clipboard::Clipboard;

/// How the text reached the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    /// Typed at the cursor.
    Typed,
    /// Put on the clipboard, to paste.
    Copied,
}

/// Types `text` where the cursor is; false where the system doesn't let us.
fn type_text(text: &str) -> bool {
    #[cfg(windows)]
    {
        windows::type_text(text);
        true
    }
    #[cfg(target_os = "macos")]
    return crate::platform::macos::keys::type_text(text);
    #[cfg(target_os = "linux")]
    return crate::platform::linux::keys::type_text(text);
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = text;
        false
    }
}

/// Puts `text` on the clipboard (and in its history); false when it can't be.
pub fn copy(app: &AppHandle, text: &str) -> bool {
    match app.try_state::<Arc<Clipboard>>().map(|c| c.copy(text.to_string())) {
        Some(Ok(())) => true,
        Some(Err(e)) => {
            eprintln!("island: couldn't copy the text: {e}");
            false
        }
        None => false,
    }
}

/// Hands `text` over: typed at the cursor where the OS allows it, else copied, and pasted where
/// only a paste key can be pressed.
pub fn deliver(app: &AppHandle, text: &str) -> Delivery {
    if type_text(text) || (copy(app, text) && paste_copied()) {
        return Delivery::Typed;
    }
    Delivery::Copied
}

/// Presses the paste key where typing isn't possible but that is (ydotool on GNOME).
fn paste_copied() -> bool {
    #[cfg(target_os = "linux")]
    {
        // Lets the compositor see the new clipboard before the target app asks for it.
        std::thread::sleep(std::time::Duration::from_millis(80));
        crate::platform::linux::keys::paste(None)
    }
    #[cfg(not(target_os = "linux"))]
    false
}
