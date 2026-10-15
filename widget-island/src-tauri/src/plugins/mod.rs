//! Every feature is a Tauri plugin: it owns its state, background threads and commands.
//! The frontend calls them as `plugin:<name>|<command>`.

pub mod clipboard;
pub mod dictation;
pub mod island;
pub mod media;
pub mod popup;
pub mod privacy;
pub mod screen;
pub mod settings;
pub mod stats;
pub mod tray;
pub mod volume;

mod live;
mod worker;
