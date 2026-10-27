//! The text selected in the app in front, for read aloud and spelling. On Linux the primary
//! selection holds it already; elsewhere it is copied with the system's copy shortcut, and the text
//! that was on the clipboard put back.

/// The selected text, trimmed; none when nothing is selected or it can't be read.
pub fn selected() -> Option<String> {
    raw().map(|text| text.trim().to_string())
}

/// The selected text as is, with the spaces around it; none when it is blank or can't be read.
pub fn raw() -> Option<String> {
    grab().filter(|text| !text.trim().is_empty())
}

#[cfg(target_os = "linux")]
fn grab() -> Option<String> {
    use arboard::{GetExtLinux, LinuxClipboardKind};
    arboard::Clipboard::new().ok()?.get().clipboard(LinuxClipboardKind::Primary).text().ok()
}

#[cfg(windows)]
fn grab() -> Option<String> {
    use crate::platform::windows::keys;
    copied(keys::copy, keys::clipboard_count)
}

#[cfg(target_os = "macos")]
fn grab() -> Option<String> {
    use crate::platform::macos::keys;
    copied(keys::copy, keys::clipboard_count)
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn grab() -> Option<String> {
    None
}

/// Presses the copy shortcut with `copy` and reads what it put on the clipboard once `count`
/// changes; none when it doesn't (nothing selected, or keys can't be sent).
#[cfg(any(windows, target_os = "macos"))]
fn copied(copy: fn() -> bool, count: fn() -> i64) -> Option<String> {
    use std::{
        thread,
        time::{Duration, Instant},
    };
    /// How long the app in front gets to answer the copy shortcut.
    const ANSWER: Duration = Duration::from_millis(600);
    const POLL: Duration = Duration::from_millis(15);

    let mut clipboard = arboard::Clipboard::new().ok()?;
    let saved = clipboard.get_text().ok();
    let before = count();
    if !copy() {
        return None;
    }
    let start = Instant::now();
    while count() == before {
        if start.elapsed() >= ANSWER {
            return None;
        }
        thread::sleep(POLL);
    }
    let text = clipboard.get_text().ok();
    // Only text can be put back: an image copied before stays replaced by the selection.
    if let Some(saved) = saved {
        let _ = clipboard.set_text(saved);
    }
    text
}
