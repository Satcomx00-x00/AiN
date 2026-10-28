//! Clipboard history: a watcher thread records new text and images, commands read and copy.
// A lock held through a `match` would deadlock `restore`, and with it the main thread reading the history.
#![warn(clippy::significant_drop_in_scrutinee)]

use std::{
    collections::VecDeque,
    hash::{DefaultHasher, Hash, Hasher},
    io,
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine as _;
use image::{
    ExtendedColorType, ImageEncoder, ImageFormat, RgbaImage,
    codecs::png::{CompressionType, FilterType, PngEncoder},
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
/// Images kept at most, the oldest leaving first: a few screenshots would otherwise hold hundreds of MB.
pub const MAX_IMAGES: usize = 5;
const MAX_BYTES: usize = 100 * 1024;
/// Bigger images (an 8K capture and up) are left out: their pixels alone are over 130 MB.
const MAX_PIXELS: usize = 40_000_000;
/// The thumbnail's longer side, in px: twice what the list shows, for high-density screens.
const THUMB: u32 = 160;
const POLL: Duration = Duration::from_millis(500);
/// Off Windows nothing says the clipboard changed, and reading an image means fetching and decoding
/// it, so images are looked at every this many polls rather than every one.
#[cfg(not(windows))]
const IMAGE_EVERY: u32 = 4;

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    pub width: u32,
    pub height: u32,
    /// A PNG data URL, at most 160 px on its longer side.
    pub thumb: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    /// Stable while the clip is in the history, for `restore`.
    pub id: u32,
    /// Empty for an image.
    pub text: String,
    pub image: Option<Picture>,
    /// Unix time in milliseconds.
    pub copied_at: u64,
}

/// What the clipboard held when read.
#[derive(Debug, Clone, PartialEq)]
pub enum Copied {
    Text(String),
    Image { width: usize, height: usize, rgba: Vec<u8> },
}

/// An image as the history keeps it: compressed, with what the list shows of it.
#[derive(Debug, Clone)]
pub struct Stored {
    png: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    hash: u64,
    thumb: String,
}

#[derive(Debug, Clone)]
enum Content {
    Text(String),
    Image(Stored),
}

/// What makes two clips the same one, copied again.
#[derive(PartialEq)]
enum Key<'a> {
    Text(&'a str),
    Image(u64),
}

impl Content {
    fn key(&self) -> Key<'_> {
        match self {
            Content::Text(t) => Key::Text(t),
            Content::Image(i) => Key::Image(i.hash),
        }
    }
}

#[derive(Debug)]
struct Entry {
    id: u32,
    content: Content,
    copied_at: u64,
}

#[derive(Debug, Default)]
pub struct History {
    entries: VecDeque<Entry>,
    next: u32,
}

impl History {
    /// Moves `text` to the front; returns false when nothing changed.
    pub fn push(&mut self, text: String, now: u64) -> bool {
        if text.trim().is_empty() || text.len() > MAX_BYTES {
            return false;
        }
        self.put(Content::Text(text), now)
    }

    /// Moves an image to the front; returns false when it already was.
    pub fn push_image(&mut self, image: Stored, now: u64) -> bool {
        self.put(Content::Image(image), now)
    }

    fn put(&mut self, content: Content, now: u64) -> bool {
        if self.entries.front().is_some_and(|e| e.content.key() == content.key()) {
            return false;
        }
        // Copied again: the same entry (and id) comes back to the front.
        let id = match self.entries.iter().position(|e| e.content.key() == content.key()) {
            Some(at) => self.entries.remove(at).map_or(self.fresh(), |e| e.id),
            None => self.fresh(),
        };
        self.entries.push_front(Entry { id, content, copied_at: now });
        self.entries.truncate(CAPACITY);
        let mut images = 0;
        self.entries.retain(|e| {
            !matches!(e.content, Content::Image(_)) || {
                images += 1;
                images <= MAX_IMAGES
            }
        });
        true
    }

    fn fresh(&mut self) -> u32 {
        self.next = self.next.wrapping_add(1);
        self.next
    }

    /// True when an image with this hash is already first: copying it again changes nothing.
    pub fn leads_with(&self, hash: u64) -> bool {
        self.entries.front().is_some_and(|e| e.content.key() == Key::Image(hash))
    }

    /// Brings a kept image back to the front by its hash, without encoding it again.
    pub fn bump_image(&mut self, hash: u64, now: u64) -> bool {
        let Some(at) = self.entries.iter().position(|e| e.content.key() == Key::Image(hash)) else { return false };
        let Some(mut entry) = self.entries.remove(at) else { return false };
        entry.copied_at = now;
        self.entries.push_front(entry);
        true
    }

    fn get(&self, id: u32) -> Option<Content> {
        self.entries.iter().find(|e| e.id == id).map(|e| e.content.clone())
    }

    pub fn items(&self) -> Vec<Clip> {
        self.entries
            .iter()
            .map(|e| match &e.content {
                Content::Text(text) => Clip { id: e.id, text: text.clone(), image: None, copied_at: e.copied_at },
                Content::Image(i) => Clip {
                    id: e.id,
                    text: String::new(),
                    image: Some(Picture { width: i.width, height: i.height, thumb: i.thumb.clone() }),
                    copied_at: e.copied_at,
                },
            })
            .collect()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// A fingerprint of an image's pixels, to tell a new image from the one already kept.
pub fn hash_of(width: usize, height: usize, rgba: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    (width, height).hash(&mut h);
    rgba.hash(&mut h);
    h.finish()
}

/// Compresses an image for the history and makes its thumbnail; `None` if it is too big or malformed.
pub fn store(width: usize, height: usize, rgba: Vec<u8>, hash: u64) -> Option<Stored> {
    if width == 0 || height == 0 || width.checked_mul(height)? > MAX_PIXELS {
        return None;
    }
    let image = RgbaImage::from_raw(u32::try_from(width).ok()?, u32::try_from(height).ok()?, rgba)?;
    let png = encode(&image)?;
    let scale = (f64::from(THUMB) / f64::from(image.width().max(image.height()))).min(1.0);
    let size = |n: u32| ((f64::from(n) * scale).round() as u32).max(1);
    let thumb = image::imageops::thumbnail(&image, size(image.width()), size(image.height()));
    let thumb = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(encode(&thumb)?));
    Some(Stored { png: Arc::new(png), width: image.width(), height: image.height(), hash, thumb })
}

/// PNG, compressed for speed: it runs on every new image copied.
fn encode(image: &RgbaImage) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(image.as_raw(), image.width(), image.height(), ExtendedColorType::Rgba8)
        .ok()?;
    Some(out)
}

/// Where new clipboard content comes from; `None` means nothing new or nothing readable.
pub trait Source {
    fn read(&mut self) -> Option<Copied>;
}

#[derive(Debug, thiserror::Error)]
pub enum CopyError {
    #[error("clipboard unavailable")]
    Unavailable,
    #[error("that clip is no longer in the history")]
    Gone,
    #[error(transparent)]
    Backend(#[from] arboard::Error),
    #[error(transparent)]
    Image(#[from] image::ImageError),
}

impl From<CopyError> for Error {
    fn from(e: CopyError) -> Self {
        Error::msg(e.to_string())
    }
}

/// Where copies go: the OS clipboard, or a stand-in in tests.
pub trait Writer: Send {
    fn text(&mut self, text: &str) -> Result<(), arboard::Error>;
    fn image(&mut self, image: arboard::ImageData<'static>) -> Result<(), arboard::Error>;
}

impl Writer for arboard::Clipboard {
    fn text(&mut self, text: &str) -> Result<(), arboard::Error> {
        self.set_text(text)
    }

    fn image(&mut self, image: arboard::ImageData<'static>) -> Result<(), arboard::Error> {
        self.set_image(image)
    }
}

#[derive(Default)]
pub struct Clipboard {
    history: Mutex<History>,
    writer: Mutex<Option<Box<dyn Writer>>>,
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
        Self::writing_to(arboard::Clipboard::new().ok().map(|c| Box::new(c) as Box<dyn Writer>))
    }

    /// Copying to `writer`, if any.
    pub fn writing_to(writer: Option<Box<dyn Writer>>) -> Self {
        Self { history: Mutex::default(), writer: Mutex::new(writer) }
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

    /// Records an image; compressing it (the slow part) happens outside the lock, and only for a new one.
    pub fn record_image(&self, width: usize, height: usize, rgba: Vec<u8>, now: u64) -> bool {
        let hash = hash_of(width, height, &rgba);
        {
            let mut history = lock(&self.history);
            if history.leads_with(hash) {
                return false;
            }
            if history.bump_image(hash, now) {
                return true;
            }
        }
        store(width, height, rgba, hash).is_some_and(|image| lock(&self.history).push_image(image, now))
    }

    /// Puts an RGBA image on the OS clipboard. Blocking, like `copy`.
    pub fn copy_image(&self, width: usize, height: usize, rgba: Vec<u8>) -> Result<(), CopyError> {
        let image = arboard::ImageData { width, height, bytes: rgba.into() };
        lock(&self.writer).as_mut().ok_or(CopyError::Unavailable)?.image(image)?;
        Ok(())
    }

    /// Blocking: another app may be holding the OS clipboard.
    pub fn copy(&self, text: String) -> Result<(), CopyError> {
        lock(&self.writer).as_mut().ok_or(CopyError::Unavailable)?.text(text.as_str())?;
        self.record(text, now_ms());
        Ok(())
    }

    /// Puts a clip from the history back on the clipboard, text or image, and moves it to the front. Blocking.
    pub fn restore(&self, id: u32) -> Result<(), CopyError> {
        // Taken out first: the history's lock must be let go before copying, which takes it again.
        let content = lock(&self.history).get(id).ok_or(CopyError::Gone)?;
        match content {
            Content::Text(text) => self.copy(text),
            Content::Image(stored) => {
                let rgba = image::load_from_memory_with_format(&stored.png, ImageFormat::Png)?.into_rgba8();
                self.copy_image(stored.width as usize, stored.height as usize, rgba.into_raw())?;
                lock(&self.history).bump_image(stored.hash, now_ms());
                Ok(())
            }
        }
    }
}

/// Reads the source once and records anything new.
pub fn poll(source: &mut impl Source, clipboard: &Clipboard, now: u64) -> bool {
    match source.read() {
        Some(Copied::Text(text)) => clipboard.record(text, now),
        Some(Copied::Image { width, height, rgba }) => clipboard.record_image(width, height, rgba, now),
        None => false,
    }
}

struct System {
    cb: arboard::Clipboard,
    #[cfg(windows)]
    seq: Option<std::num::NonZeroU32>,
    #[cfg(not(windows))]
    polls: u32,
}

impl System {
    /// An image, when the clipboard holds one rather than text.
    fn image(&mut self) -> Option<Copied> {
        let image = self.cb.get_image().ok()?;
        Some(Copied::Image { width: image.width, height: image.height, rgba: image.bytes.into_owned() })
    }
}

impl Source for System {
    fn read(&mut self) -> Option<Copied> {
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
        if let Ok(text) = self.cb.get_text() {
            return Some(Copied::Text(text));
        }
        #[cfg(not(windows))]
        {
            self.polls = self.polls.wrapping_add(1);
            if !self.polls.is_multiple_of(IMAGE_EVERY) {
                return None;
            }
        }
        self.image()
    }
}

pub fn watch(clipboard: Arc<Clipboard>) -> io::Result<()> {
    thread::Builder::new().name("clipboard-watch".into()).spawn(move || {
        let Ok(cb) = arboard::Clipboard::new() else { return };
        let mut source = System {
            cb,
            #[cfg(windows)]
            seq: None,
            #[cfg(not(windows))]
            polls: 0,
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

/// Puts a history clip back on the clipboard, text or image; off the main thread, like `copy`.
#[tauri::command]
#[specta::specta]
async fn restore(clipboard: State<'_, Arc<Clipboard>>, id: u32) -> Res<()> {
    let clipboard = Arc::clone(&clipboard);
    tauri::async_runtime::spawn_blocking(move || clipboard.restore(id)).await??;
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
        fn read(&mut self) -> Option<Copied> {
            self.0.pop().flatten().map(|t| Copied::Text(t.into()))
        }
    }

    /// A `w`×`h` image of one color.
    fn pixels(w: usize, h: usize, shade: u8) -> Vec<u8> {
        [shade, 0, 0, 255].repeat(w * h)
    }

    fn image(w: usize, h: usize, shade: u8) -> Stored {
        let rgba = pixels(w, h, shade);
        let hash = hash_of(w, h, &rgba);
        store(w, h, rgba, hash).unwrap()
    }

    #[test]
    fn stores_an_image_with_a_thumbnail_that_keeps_its_shape() {
        let clipboard = Clipboard::default();
        assert!(clipboard.record_image(640, 320, pixels(640, 320, 9), 5));
        let [clip] = clipboard.items().try_into().unwrap();
        let picture = clip.image.unwrap();
        assert_eq!((clip.text.as_str(), picture.width, picture.height, clip.copied_at), ("", 640, 320, 5));
        let png = base64::engine::general_purpose::STANDARD.decode(picture.thumb.strip_prefix("data:image/png;base64,").unwrap()).unwrap();
        let thumb = image::load_from_memory(&png).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (160, 80));
    }

    #[test]
    fn the_same_image_again_is_not_a_new_clip() {
        let clipboard = Clipboard::default();
        assert!(clipboard.record_image(4, 4, pixels(4, 4, 1), 0));
        assert!(!clipboard.record_image(4, 4, pixels(4, 4, 1), 1));
        clipboard.record("text".into(), 2);
        let id = clipboard.items()[1].id;
        // Copied again after some text: back to the front, same entry.
        assert!(clipboard.record_image(4, 4, pixels(4, 4, 1), 3));
        assert_eq!(
            clipboard.items().iter().map(|c| (c.id, c.image.is_some())).collect::<Vec<_>>(),
            [(id, true), (clipboard.items()[1].id, false)]
        );
    }

    #[test]
    fn keeps_the_newest_images_only() {
        let mut h = History::default();
        h.push("note".into(), 0);
        (0..MAX_IMAGES + 2).for_each(|i| _ = h.push_image(image(2, 2, i as u8), i as u64 + 1));
        let items = h.items();
        assert_eq!(items.iter().filter(|c| c.image.is_some()).count(), MAX_IMAGES);
        assert_eq!(items.last().unwrap().text, "note");
        assert_eq!(items[0].copied_at, MAX_IMAGES as u64 + 2);
    }

    #[test]
    fn leaves_out_images_too_big_or_empty() {
        assert!(store(0, 10, vec![], 0).is_none());
        assert!(store(MAX_PIXELS + 1, 1, vec![], 0).is_none());
        assert!(store(2, 2, vec![0; 3], 0).is_none());
    }

    #[test]
    fn ids_stay_put_while_clips_move() {
        let mut h = with(&["b", "a"]);
        let a = h.items()[1].id;
        h.push("a".into(), 1);
        assert_eq!(h.items()[0].id, a);
        assert_ne!(h.items()[1].id, a);
    }

    /// A clipboard that keeps what is copied to it: the last text, or the last image's size.
    #[derive(Clone, Default)]
    struct Kept(Arc<Mutex<Vec<String>>>);

    impl Writer for Kept {
        fn text(&mut self, text: &str) -> Result<(), arboard::Error> {
            lock(&self.0).push(text.into());
            Ok(())
        }

        fn image(&mut self, image: arboard::ImageData<'static>) -> Result<(), arboard::Error> {
            lock(&self.0).push(format!("{}x{} image", image.width, image.height));
            Ok(())
        }
    }

    #[test]
    fn restores_text_and_images_and_lets_the_history_be_read_after() {
        let kept = Kept::default();
        let clipboard = Arc::new(Clipboard::writing_to(Some(Box::new(kept.clone()))));
        clipboard.record("note".into(), 1);
        clipboard.record_image(3, 2, pixels(3, 2, 7), 2);
        clipboard.record("later".into(), 3);
        let ids: Vec<u32> = clipboard.items().iter().map(|c| c.id).collect();
        // On a thread with a deadline: a lock kept while copying would hang here, as it froze the app.
        let (done, wait) = std::sync::mpsc::channel();
        let c = Arc::clone(&clipboard);
        thread::spawn(move || {
            let results = [c.restore(ids[1]).is_ok(), c.restore(ids[2]).is_ok()];
            done.send((results, c.items().len())).unwrap();
        });
        let (results, count) = wait.recv_timeout(Duration::from_secs(5)).expect("restore must not deadlock");
        assert_eq!((results, count), ([true, true], 3));
        assert_eq!(*lock(&kept.0), ["3x2 image", "note"]);
        let items = clipboard.items();
        assert_eq!((items[0].text.as_str(), items[1].image.is_some()), ("note", true));
    }

    #[test]
    fn restoring_a_clip_no_longer_kept_is_an_error() {
        assert!(matches!(Clipboard::default().restore(42), Err(CopyError::Gone)));
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
