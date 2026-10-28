//! The island window: places it and keeps its input region in sync with the pill.

mod hit;
mod window;

use std::{
    sync::{Arc, RwLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{LogicalSize, Manager, State, Window, Wry, plugin::TauriPlugin};
use tauri_specta::Event;

use crate::Res;
use hit::{AutoHide, HitArea};
pub use window::{Island, is_wayland_surface};

const LABEL: &str = "widget";

#[derive(Debug, Clone, Copy, Deserialize, Type)]
pub struct Size {
    width: f64,
    height: f64,
}

/// A part of the window that takes input besides the pill (a bubble), in logical px from its top left.
#[derive(Debug, Clone, Copy, Deserialize, Type)]
pub struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Starts as the fallback size and is replaced once the native window has been measured.
#[derive(Debug)]
struct Info(RwLock<Island>);

#[tauri::command]
#[specta::specta]
fn info(info: State<'_, Info>) -> Island {
    *info.0.read().unwrap_or_else(|e| e.into_inner())
}

/// `canvas` is the largest the window ever needs to be; `region` is the part that takes input now,
/// with the `extra` areas (bubbles beside or under the pill).
///
/// Async on purpose: a sync command runs inside WebView2's IPC callback on the main thread, and
/// resizing the window from there deadlocks. Off the main thread, window calls are queued instead.
#[tauri::command]
#[specta::specta]
async fn layout(window: Window, hit: State<'_, Arc<HitArea>>, canvas: Size, region: Size, extra: Vec<Area>) -> Res<()> {
    let (canvas, region) = (window::clamp(canvas.width, canvas.height), window::clamp(region.width, region.height));
    // Not resized to the region there: each resize (and move, under XWayland) lands a frame or more
    // after the last, so the pill jumped and shook as it opened and folded.
    #[cfg(target_os = "linux")]
    if window::is_wayland() {
        hit.ensure_canvas(canvas, |c| window::place(&window, c))?;
        let areas: Vec<_> = extra.iter().map(|a| (a.x, a.y, a.width, a.height)).collect();
        return window::take_input(&window, canvas, region, &areas);
    }
    let placed = hit.ensure_canvas(canvas, |c| window::place(&window, c))?;
    let bubbles = extra.iter().map(|a| hit::area_rect(placed, a.x, a.y, a.width, a.height));
    hit.set_regions(std::iter::once(hit::region_rect(placed, region, hit::MARGIN)).chain(bubbles).collect());
    hit.ensure_tracking(|area| {
        let w = window.clone();
        hit::track(window.clone(), area, move |shown| {
            if let Err(e) = Revealed(shown).emit(&w) {
                eprintln!("island: failed to report the pill shown or hidden: {e}");
            }
        })
    })?;
    Ok(())
}

/// The pill was shown (true) or hidden (false) by the auto-hide rule.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct Revealed(pub bool);

/// Hides the pill until the cursor rests at the top center for `dwell` ms; once shown, it hides
/// again `grace` ms after the cursor leaves. `dwell: null` keeps it shown. No effect on Wayland,
/// which can't report the cursor.
#[tauri::command]
#[specta::specta]
fn auto_hide(hit: State<'_, Arc<HitArea>>, dwell: Option<u32>, grace: u32) {
    let ms = |v: u32| Duration::from_millis(v.into());
    hit.set_auto_hide(dwell.map(|d| AutoHide { dwell: ms(d), grace: ms(grace) }));
}

fn prepare(w: &Window) -> Res<()> {
    window::place(w, LogicalSize::new(window::FALLBACK.width, window::FALLBACK.height))?;
    let island = window::native(w)?;
    window::place(w, LogicalSize::new(island.width, island.height))?;
    *w.state::<Info>().0.write().unwrap_or_else(|e| e.into_inner()) = island;
    w.show()?;
    Ok(())
}

crate::ipc::island!();

pub fn init() -> TauriPlugin<Wry> {
    ipc()
        .builder(|app| {
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
