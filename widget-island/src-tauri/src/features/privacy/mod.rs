//! Which apps are using the microphone or the camera right now. Windows keeps a record of it
//! (`windows.rs`); on Linux, recording streams and open camera devices tell (`linux.rs`).

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State, Wry, plugin::TauriPlugin};
use tauri_specta::Event;

use super::live::Live;

const POLL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Usage {
    pub mic: Vec<String>,
    pub camera: Vec<String>,
}

/// Who uses the mic and camera now (none where the OS can't tell), sent whenever it changes.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct UsageChanged(pub Option<Usage>);

/// Whether this platform can tell at all.
const SUPPORTED: bool = cfg!(any(windows, target_os = "linux"));

/// This platform's answer, sorted and without duplicates.
fn read() -> Usage {
    #[cfg(windows)]
    return windows::read();
    #[cfg(target_os = "linux")]
    return linux::read();
    #[cfg(not(any(windows, target_os = "linux")))]
    Usage::default()
}

struct Privacy(Arc<Live<Option<Usage>>>);

/// `None` where the OS doesn't report usage.
#[tauri::command]
#[specta::specta]
fn state(privacy: State<'_, Privacy>) -> Option<Usage> {
    privacy.0.get()
}

fn spawn(app: AppHandle, live: Arc<Live<Option<Usage>>>) -> std::io::Result<()> {
    super::worker::spawn::<_, ()>(
        "privacy",
        POLL,
        || (),
        move |_, _| {
            let usage = Some(read());
            if live.set(usage.clone()) {
                let _ = UsageChanged(usage).emit(&app);
            }
        },
    )?;
    Ok(())
}

crate::ipc::privacy!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let live = Arc::new(Live::default());
        if SUPPORTED {
            spawn(app.clone(), Arc::clone(&live))?;
        }
        app.manage(Privacy(live));
        Ok(())
    })
}
