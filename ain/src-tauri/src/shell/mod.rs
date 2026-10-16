//! The app itself: the island window, its settings, the tray, global shortcuts with their popup and
//! capture overlay, and the loader for third-party plugins. Features build on this; it knows none of them.

pub mod capture;
pub mod extensions;
pub mod island;
pub mod popup;
pub mod renamed;
pub mod settings;
pub mod tray;

use tauri::{Builder, Wry};

pub fn register(app: Builder<Wry>) -> Builder<Wry> {
    app.plugin(settings::init())
        .plugin(popup::init())
        .plugin(capture::init())
        .plugin(extensions::init())
        .plugin(tray::init())
        .plugin(island::init())
}
