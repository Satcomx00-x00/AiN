#[macro_use]
mod manifest;

mod error;
mod features;
mod ipc;
mod platform;
mod shell;

pub(crate) use error::{Error, Res};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything reads its folders: the app's data from when it had its old name.
    shell::renamed::move_data();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init());
    // The shell first: features listen to its events (settings, shortcuts), which must exist by then.
    let app = shell::register(app);
    features::register(app)
        .setup(|_app| {
            shell::renamed::move_autostart(_app.handle());
            #[cfg(target_os = "macos")]
            _app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri runtime failed");
}
