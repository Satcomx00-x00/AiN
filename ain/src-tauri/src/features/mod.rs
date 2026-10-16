//! What the island shows: each feature is a Tauri plugin owning its state, background threads and
//! commands, listed in `manifest.rs`. Features that read the OS keep one backend per platform
//! beside them (`windows.rs`, `linux.rs`) behind a small trait; where none exists, the feature
//! reports "unsupported" instead of failing.

pub mod clipboard;
pub mod dictation;
pub mod media;
pub mod privacy;
pub mod stats;
pub mod volume;

mod live;
mod worker;

use tauri::{Builder, Wry};

pub fn register(app: Builder<Wry>) -> Builder<Wry> {
    app.plugin(stats::init())
        .plugin(clipboard::init())
        .plugin(media::init())
        .plugin(volume::init())
        .plugin(privacy::init())
        .plugin(dictation::init())
}
