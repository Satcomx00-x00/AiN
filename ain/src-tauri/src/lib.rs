#[macro_use]
mod manifest;

mod error;
mod features;
mod ipc;
mod platform;
mod shell;

pub(crate) use error::{Error, Res};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Where a panic is written down: the app has no console once installed, so what made it stop
/// would be lost. In its data folder, beside its settings.
fn crash_log() -> Option<std::path::PathBuf> {
    Some(dirs::data_dir()?.join(shell::renamed::NEW_ID).join("crash.log"))
}

/// Writes every panic to the crash log (when, which thread, where, why, and the backtrace), then
/// lets Rust report it as usual.
fn log_panics() {
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(path) = crash_log() {
            let thread = std::thread::current();
            let when = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
            let backtrace = std::backtrace::Backtrace::force_capture();
            let entry = format!("--- panic at unix time {when}, thread {:?}\n{info}\n{backtrace}\n", thread.name().unwrap_or("unnamed"));
            let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut f| std::io::Write::write_all(&mut f, entry.as_bytes()));
        }
        report(info);
    }));
}

pub fn run() {
    // `ain --cleanup`: undo what the app registered outside its files, and stop there. Before the
    // crash log, which would recreate the data folder a purge removes.
    if let Some(request) = shell::cleanup::Request::parse(std::env::args()) {
        std::process::exit(shell::cleanup::run(&request));
    }
    log_panics();
    #[cfg(target_os = "linux")]
    platform::linux::prefer_xwayland();
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
