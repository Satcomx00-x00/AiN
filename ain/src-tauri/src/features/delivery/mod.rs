//! Handing text to the app in front, shared by dictation and spelling: typed at the cursor
//! (`windows.rs`; on Linux, the platform's key helpers), which also replaces a selection,
//! or put on the clipboard when the system won't let us type: Wayland without `wtype` or `ydotool`, X11 without `xdotool`. On Linux it
//! is pasted by default (a feature's "typing" option): the typing tools press keys of the US layout,
//! or of whichever layout they assume, so on AZERTY the words would come out wrong without any error.

#[cfg(windows)]
mod windows;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Manager};

use super::clipboard::Clipboard;
use crate::shell::settings;

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
    #[cfg(target_os = "linux")]
    return crate::platform::linux::keys::type_text(text);
    #[cfg(not(any(windows, target_os = "linux")))]
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

/// Whether `feature` pastes its text rather than typing it key by key: its "typing" option, which
/// by default pastes on Linux, where typing depends on the keyboard layout.
pub fn pastes(settings: &Value, feature: &str) -> bool {
    match settings::option(settings, feature, "typing").and_then(Value::as_str) {
        Some("paste") => true,
        Some("keys") => false,
        _ => cfg!(target_os = "linux"),
    }
}

/// Hands `text` over: typed at the cursor where the OS allows it (unless it is to be pasted), else
/// copied, and pasted where a paste key can be pressed.
pub fn deliver(app: &AppHandle, text: &str, paste: bool) -> Delivery {
    if (!paste && type_text(text)) || (copy(app, text) && paste_copied()) {
        return Delivery::Typed;
    }
    Delivery::Copied
}

/// Presses the paste key in the focused app (on GNOME's Wayland, only ydotool can).
fn paste_copied() -> bool {
    #[cfg(target_os = "linux")]
    {
        // Lets the compositor see the new clipboard before the target app asks for it.
        std::thread::sleep(std::time::Duration::from_millis(80));
        let pasted = crate::platform::linux::keys::paste(None);
        if !pasted {
            eprintln!("island: couldn't press Ctrl+V (install ydotool, with ydotoold running, or wtype on Wayland; xdotool on X11)");
        }
        pasted
    }
    #[cfg(not(target_os = "linux"))]
    {
        crate::shell::popup::paste_now();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pastes_on_linux_unless_told() {
        let typing = |v: &str| serde_json::json!({ "options": { "spelling": { "typing": v } } });
        assert!(pastes(&typing("paste"), "spelling"));
        assert!(!pastes(&typing("keys"), "spelling"));
        assert_eq!(pastes(&serde_json::json!({}), "spelling"), cfg!(target_os = "linux"));
    }
}
