//! Clipboard history: a watcher thread records new text, commands read and copy.

use std::{
    collections::VecDeque,
    io,
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use specta::Type;
use tauri::{
    Manager, State, Wry,
    ipc::{InvokeBody, Request},
    plugin::TauriPlugin,
};

use crate::{Error, Res};

pub const CAPACITY: usize = 25;
const MAX_BYTES: usize = 100 * 1024;
const POLL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub text: String,
    /// Unix time in milliseconds.
    pub copied_at: u64,
}

#[derive(Debug, Default)]
pub struct History(VecDeque<Clip>);

impl History {
    /// Moves `text` to the front; returns false when nothing changed.
    pub fn push(&mut self, text: String, now: u64) -> bool {
        if text.trim().is_empty() || text.len() > MAX_BYTES || self.0.front().is_some_and(|c| c.text == text) {
            return false;
        }
        self.0.retain(|c| c.text != text);
        self.0.push_front(Clip { text, copied_at: now });
        self.0.truncate(CAPACITY);
        true
    }

    pub fn items(&self) -> Vec<Clip> {
        self.0.iter().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }
}

/// Where new clipboard text comes from; `None` means nothing new or nothing readable.
pub trait Source {
    fn read(&mut self) -> Option<String>;
}

#[derive(Debug, thiserror::Error)]
pub enum CopyError {
    #[error("clipboard unavailable")]
    Unavailable,
    #[error(transparent)]
    Backend(#[from] arboard::Error),
}

impl From<CopyError> for Error {
    fn from(e: CopyError) -> Self {
        Error::msg(e.to_string())
    }
}

#[derive(Default)]
pub struct Clipboard {
    history: Mutex<History>,
    writer: Mutex<Option<arboard::Clipboard>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl Clipboard {
    /// Backed by the OS clipboard; copying fails gracefully if it can't be opened.
    pub fn system() -> Self {
        Self { history: Mutex::default(), writer: Mutex::new(arboard::Clipboard::new().ok()) }
    }

    pub fn items(&self) -> Vec<Clip> {
        lock(&self.history).items()
    }

    pub fn clear(&self) {
        lock(&self.history).clear();
    }

    pub fn record(&self, text: String, now: u64) -> bool {
        lock(&self.history).push(text, now)
    }

    /// Puts an RGBA image on the OS clipboard. Blocking, like `copy`.
    pub fn copy_image(&self, width: usize, height: usize, rgba: Vec<u8>) -> Result<(), CopyError> {
        let image = arboard::ImageData { width, height, bytes: rgba.into() };
        lock(&self.writer).as_mut().ok_or(CopyError::Unavailable)?.set_image(image)?;
        Ok(())
    }

    /// Blocking: another app may be holding the OS clipboard.
    pub fn copy(&self, text: String) -> Result<(), CopyError> {
        lock(&self.writer).as_mut().ok_or(CopyError::Unavailable)?.set_text(text.as_str())?;
        self.record(text, now_ms());
        Ok(())
    }
}

/// Reads the source once and records anything new.
pub fn poll(source: &mut impl Source, clipboard: &Clipboard, now: u64) -> bool {
    source.read().is_some_and(|text| clipboard.record(text, now))
}

struct System {
    cb: arboard::Clipboard,
    #[cfg(windows)]
    seq: Option<std::num::NonZeroU32>,
}

impl Source for System {
    fn read(&mut self) -> Option<String> {
        // Windows bumps a sequence number on every change, so we only open the clipboard
        // when something changed, and skip what password managers mark as secret.
        #[cfg(windows)]
        {
            let seq = clipboard_win::seq_num();
            if seq == self.seq {
                return None;
            }
            self.seq = seq;
            let secret = clipboard_win::register_format("ExcludeClipboardContentFromMonitorProcessing")
                .is_some_and(|f| clipboard_win::is_format_avail(f.get()));
            if secret {
                return None;
            }
        }
        self.cb.get_text().ok()
    }
}

pub fn watch(clipboard: Arc<Clipboard>) -> io::Result<()> {
    thread::Builder::new().name("clipboard-watch".into()).spawn(move || {
        let Ok(cb) = arboard::Clipboard::new() else { return };
        let mut source = System {
            cb,
            #[cfg(windows)]
            seq: None,
        };
        loop {
            poll(&mut source, &clipboard, now_ms());
            thread::sleep(POLL);
        }
    })?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn history(clipboard: State<'_, Arc<Clipboard>>) -> Vec<Clip> {
    clipboard.items()
}

#[tauri::command]
#[specta::specta]
fn clear(clipboard: State<'_, Arc<Clipboard>>) {
    clipboard.clear();
}

/// Writing can block while another app holds the OS clipboard, so it runs off the main thread.
#[tauri::command]
#[specta::specta]
async fn copy(clipboard: State<'_, Arc<Clipboard>>, text: String) -> Res<()> {
    let clipboard = Arc::clone(&clipboard);
    tauri::async_runtime::spawn_blocking(move || clipboard.copy(text)).await??;
    Ok(())
}

/// Copies raw RGBA pixels (the request body) sized by the `x-width` and `x-height` headers.
#[tauri::command]
async fn copy_image(clipboard: State<'_, Arc<Clipboard>>, request: Request<'_>) -> Res<()> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
    let (Some(width), Some(height)) = (header("x-width"), header("x-height")) else {
        return Err(Error::msg("missing image size"));
    };
    let InvokeBody::Raw(rgba) = request.body() else { return Err(Error::msg("expected image bytes")) };
    if width.checked_mul(height).and_then(|n| n.checked_mul(4)) != Some(rgba.len()) {
        return Err(Error::msg(format!("{} bytes is not a {width}x{height} RGBA image", rgba.len())));
    }
    let (clipboard, rgba) = (Arc::clone(&clipboard), rgba.clone());
    tauri::async_runtime::spawn_blocking(move || clipboard.copy_image(width, height, rgba)).await??;
    Ok(())
}

crate::ipc::clipboard!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let clipboard = Arc::new(Clipboard::system());
        watch(Arc::clone(&clipboard))?;
        app.manage(clipboard);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(items: &[&str]) -> History {
        let mut h = History::default();
        items.iter().rev().for_each(|t| _ = h.push(t.to_string(), 0));
        h
    }

    fn texts(items: Vec<Clip>) -> Vec<String> {
        items.into_iter().map(|c| c.text).collect()
    }

    #[test]
    fn newest_first() {
        assert_eq!(texts(with(&["b", "a"]).items()), ["b", "a"]);
    }

    #[test]
    fn recopy_moves_to_front_without_duplicate() {
        let mut h = with(&["b", "a"]);
        assert!(h.push("a".into(), 7));
        assert_eq!(texts(h.items()), ["a", "b"]);
        assert_eq!(h.items()[0].copied_at, 7);
    }

    #[test]
    fn same_as_front_is_noop() {
        assert!(!with(&["a"]).push("a".into(), 1));
    }

    #[test]
    fn ignores_blank_and_huge() {
        let mut h = History::default();
        assert!(!h.push("  \n".into(), 0));
        assert!(!h.push("x".repeat(MAX_BYTES + 1), 0));
    }

    #[test]
    fn keeps_capacity() {
        let mut h = History::default();
        (0..CAPACITY + 5).for_each(|i| _ = h.push(i.to_string(), 0));
        assert_eq!(h.items().len(), CAPACITY);
        assert_eq!(h.items()[0].text, (CAPACITY + 4).to_string());
    }

    struct Fake(Vec<Option<&'static str>>);

    impl Source for Fake {
        fn read(&mut self) -> Option<String> {
            self.0.pop().flatten().map(String::from)
        }
    }

    #[test]
    fn poll_records_only_new_text() {
        let clipboard = Clipboard::default();
        let mut source = Fake(vec![Some("b"), None, Some("a"), Some("a")]);
        let recorded: Vec<bool> = (0..4).map(|t| poll(&mut source, &clipboard, t)).collect();
        assert_eq!(recorded, [true, false, false, true]);
        assert_eq!(texts(clipboard.items()), ["b", "a"]);
    }

    #[test]
    fn copy_without_os_clipboard_is_an_error() {
        assert!(matches!(Clipboard::default().copy("x".into()), Err(CopyError::Unavailable)));
    }
}
