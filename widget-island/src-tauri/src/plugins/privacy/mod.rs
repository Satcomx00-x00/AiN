//! Which apps are using the microphone or the camera right now.

#[cfg(windows)]
mod windows;

use std::{sync::Arc, time::Duration};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State,
    plugin::{Builder, TauriPlugin},
};

use super::live::Live;

pub const EVENT: &str = "privacy:state";
#[cfg_attr(not(windows), allow(dead_code))]
const POLL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Usage {
    pub mic: Vec<String>,
    pub camera: Vec<String>,
}

/// A recording session is ongoing while it has started and not yet stopped.
pub fn in_use(started: u64, stopped: u64) -> bool {
    started > 0 && stopped == 0
}

/// Registry key names: packaged apps are "Publisher.Name_hash", desktop apps their exe path with
/// `#` for `\`. "Microsoft.WindowsCamera_8wekyb3d8bbwe" → "WindowsCamera", "C:#…#Zoom.exe" → "Zoom".
pub fn app_label(key: &str) -> String {
    if key.contains('#') {
        let file = key.rsplit('#').next().unwrap_or(key);
        return match file.len().checked_sub(4) {
            Some(cut) if file.is_char_boundary(cut) && file[cut..].eq_ignore_ascii_case(".exe") => file[..cut].into(),
            _ => file.into(),
        };
    }
    let name = key.split('_').next().unwrap_or(key);
    name.rsplit('.').next().unwrap_or(name).into()
}

struct Privacy(Arc<Live<Option<Usage>>>);

/// `None` where the OS doesn't report usage.
#[tauri::command]
fn state(privacy: State<'_, Privacy>) -> Option<Usage> {
    privacy.0.get()
}

#[cfg(windows)]
fn spawn<R: Runtime>(app: AppHandle<R>, live: Arc<Live<Option<Usage>>>) -> std::io::Result<()> {
    super::worker::spawn::<_, ()>(
        "privacy",
        POLL,
        || (),
        move |_, _| {
            let usage = Some(windows::read());
            if live.set(usage.clone()) {
                let _ = app.emit(EVENT, usage);
            }
        },
    )?;
    Ok(())
}

#[cfg(not(windows))]
fn spawn<R: Runtime>(_: AppHandle<R>, _: Arc<Live<Option<Usage>>>) -> std::io::Result<()> {
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("privacy")
        .invoke_handler(tauri::generate_handler![state])
        .setup(|app, _| {
            let live = Arc::new(Live::default());
            spawn(app.clone(), Arc::clone(&live))?;
            app.manage(Privacy(live));
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_use_only_between_start_and_stop() {
        assert!(in_use(133_000, 0));
        assert!(!in_use(133_000, 133_100));
        assert!(!in_use(0, 0));
    }

    #[test]
    fn labels_packaged_and_desktop_apps() {
        assert_eq!(app_label("Microsoft.WindowsCamera_8wekyb3d8bbwe"), "WindowsCamera");
        assert_eq!(app_label(r"C:#Users#me#AppData#Roaming#Zoom#bin#Zoom.exe"), "Zoom");
        assert_eq!(app_label("C:#Tools#recorder"), "recorder");
    }
}
