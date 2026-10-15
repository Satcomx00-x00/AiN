mod plugins;

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Clipboard(#[from] plugins::clipboard::CopyError),
    #[error("no monitor available")]
    NoMonitor,
    #[error("not supported on this platform")]
    Unsupported,
    #[error("background worker stopped")]
    WorkerGone,
    #[error("launch at login: {0}")]
    Autostart(String),
    #[error("screen capture: {0}")]
    Capture(String),
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub(crate) type Res<T> = Result<T, Error>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(plugins::popup::init())
        .plugin(plugins::screen::init())
        .plugin(plugins::settings::init())
        .plugin(plugins::tray::init())
        .plugin(plugins::island::init())
        .plugin(plugins::stats::init())
        .plugin(plugins::clipboard::init())
        .plugin(plugins::media::init())
        .plugin(plugins::volume::init())
        .plugin(plugins::privacy::init())
        .plugin(plugins::dictation::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            _app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri runtime failed");
}
