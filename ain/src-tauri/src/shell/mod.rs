//! The app itself: the island window, its settings, the tray, global shortcuts with their popup and
//! capture overlay, the loader for third-party plugins, their secrets and online accounts, the AI providers, the network policy (certificates, models source), the community store, and self-update. Features build on this; it knows none of them.

pub mod capture;
pub mod cleanup;
pub mod extensions;
pub mod island;
pub mod net;
pub mod oauth;
pub mod popup;
pub mod providers;
pub mod renamed;
pub mod secrets;
pub mod settings;
pub mod store;
pub mod tray;
pub mod updater;

use tauri::{Builder, Wry};

pub fn register(app: Builder<Wry>) -> Builder<Wry> {
    updater::register(app)
        .plugin(settings::init())
        .plugin(popup::init())
        .plugin(capture::init())
        .plugin(extensions::init())
        .plugin(store::init())
        .plugin(secrets::init())
        .plugin(oauth::init())
        .plugin(providers::init())
        .plugin(tray::init())
        .plugin(island::init())
}
