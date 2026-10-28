//! What the island shows: each feature is a Tauri plugin owning its state, background threads and
//! commands, listed in `manifest.rs`. Features that read the OS keep one backend per platform
//! beside them (`windows.rs`, `linux.rs`) behind a small trait; where none exists, the feature
//! reports "unsupported" instead of failing.

pub mod clipboard;
pub mod dictation;
pub mod media;
pub mod persona;
pub mod privacy;
pub mod spelling;
pub mod stats;
pub mod transcript;
pub mod tts;
pub mod volume;

mod audio;
mod delivery;
mod download;
mod live;
mod microphone;
mod models;
mod selection;
mod speakers;
mod worker;

use std::sync::{Mutex, MutexGuard};

use tauri::{Builder, Wry};

pub fn register(app: Builder<Wry>) -> Builder<Wry> {
    app.plugin(stats::init())
        .plugin(clipboard::init())
        .plugin(media::init())
        .plugin(volume::init())
        .plugin(privacy::init())
        .plugin(dictation::init())
        .plugin(tts::init())
        .plugin(transcript::init())
        .plugin(persona::init())
        .plugin(spelling::init())
}

/// A poisoned lock still holds usable audio or state: carry on with it.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
