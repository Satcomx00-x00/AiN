//! The island shell: places the `widget` window and keeps its input region in sync with the pill.

mod hit;
mod window;

use std::sync::{Arc, RwLock};

use serde::Deserialize;
use tauri::{
    LogicalSize, Manager, Runtime, State, Window,
    plugin::{Builder, TauriPlugin},
};

use crate::Res;
use hit::HitArea;
use window::Island;

const LABEL: &str = "widget";

#[derive(Debug, Clone, Copy, Deserialize)]
struct Size {
    width: f64,
    height: f64,
}

/// Starts as the fallback size and is replaced once the native window has been measured.
#[derive(Debug)]
struct Info(RwLock<Island>);

#[tauri::command]
fn info(info: State<'_, Info>) -> Island {
    *info.0.read().unwrap_or_else(|e| e.into_inner())
}

/// `canvas` is the largest the window ever needs to be; `region` is the part that takes input now.
///
/// Async on purpose: a sync command runs inside WebView2's IPC callback on the main thread, and
/// resizing the window from there deadlocks. Off the main thread, window calls are queued instead.
#[tauri::command]
async fn layout<R: Runtime>(window: Window<R>, hit: State<'_, Arc<HitArea>>, canvas: Size, region: Size) -> Res<()> {
    let region = window::clamp(region.width, region.height);
    if window::is_wayland() {
        window::place(&window, region)?;
        return Ok(());
    }
    let placed = hit.ensure_canvas(window::clamp(canvas.width, canvas.height), |c| window::place(&window, c))?;
    hit.set_region(hit::region_rect(placed, region, hit::MARGIN));
    hit.ensure_tracking(|area| hit::track(window.clone(), area))?;
    Ok(())
}

fn prepare<R: Runtime>(w: &Window<R>) -> Res<()> {
    window::place(w, LogicalSize::new(window::FALLBACK.width, window::FALLBACK.height))?;
    let island = window::native(w)?;
    window::place(w, LogicalSize::new(island.width, island.height))?;
    *w.state::<Info>().0.write().unwrap_or_else(|e| e.into_inner()) = island;
    w.show()?;
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("island")
        .invoke_handler(tauri::generate_handler![info, layout])
        .setup(|app, _| {
            app.manage(Info(RwLock::new(window::FALLBACK)));
            app.manage(Arc::new(HitArea::default()));
            Ok(())
        })
        .on_window_ready(|w| {
            if w.label() == LABEL
                && let Err(e) = prepare(&w)
            {
                eprintln!("island: failed to prepare window: {e}");
            }
        })
        .build()
}
