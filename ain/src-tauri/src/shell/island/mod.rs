//! The island window: places it and keeps its input region in sync with the pill.

mod hit;
mod screens;
mod window;

use std::{
    io,
    sync::{Arc, RwLock},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, LogicalSize, Manager, State, Window, Wry, async_runtime::spawn_blocking, plugin::TauriPlugin};
use tauri_specta::Event;

use crate::{
    Res,
    shell::settings::{self, SettingsChanged},
};
use hit::{AutoHide, HitArea};
use screens::{Screen, ScreensChanged};
pub use window::Island;

const LABEL: &str = "widget";

#[derive(Debug, Clone, Copy, Deserialize, Type)]
pub struct Size {
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

/// The screen picked in Settings, by id; `None` for the primary.
#[derive(Debug, Default)]
struct Wanted(RwLock<Option<String>>);

impl Wanted {
    fn get(&self) -> Option<String> {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Whether it changed.
    fn set(&self, next: Option<String>) -> bool {
        std::mem::replace(&mut *self.0.write().unwrap_or_else(|e| e.into_inner()), next.clone()) != next
    }
}

/// How often the screens are listed again, to notice one plugged in or out.
const SCREENS_POLL: Duration = Duration::from_secs(2);

fn list(app: &AppHandle) -> Res<Vec<Screen>> {
    Ok(screens::describe(&app.available_monitors()?, app.primary_monitor()?.as_ref()))
}

/// The connected screens, for Settings to pick the pill's from. Async: listing them waits on the
/// main thread.
#[tauri::command]
#[specta::specta]
async fn screens(app: AppHandle) -> Res<Vec<Screen>> {
    list(&app)
}

/// Moves the pill to the screen it belongs on now: the wanted one, or the primary while it's away.
fn relocate(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LABEL).map(|v| v.as_ref().window()) else { return };
    let wanted = app.state::<Wanted>().get();
    if let Err(e) = app.state::<Arc<HitArea>>().relocate(|c| window::place(&w, c, wanted.as_deref())) {
        eprintln!("island: failed to move the pill to its screen: {e}");
    }
}

/// Follows the screen picked in Settings, and screens plugged in, out or rearranged.
fn watch_screens(app: &AppHandle) -> io::Result<()> {
    let handle = app.clone();
    SettingsChanged::listen_any(app, move |e| {
        // Off the IPC callback that saved the settings: moving the window from there deadlocks on Windows.
        if handle.state::<Wanted>().set(screens::wanted(&e.payload.0.0)) {
            let app = handle.clone();
            spawn_blocking(move || relocate(&app));
        }
    });
    let app = app.clone();
    thread::Builder::new().name("screens".into()).spawn(move || {
        let mut known = None;
        loop {
            thread::sleep(SCREENS_POLL);
            let Ok(now) = list(&app) else { continue };
            if known.replace(now.clone()).is_some_and(|before| before != now) {
                relocate(&app);
                if let Err(e) = ScreensChanged(now).emit(&app) {
                    eprintln!("island: failed to report the screens: {e}");
                }
            }
        }
    })?;
    Ok(())
}

/// `canvas` is the largest the window ever needs to be; `region` is the part that takes input now.
///
/// Async on purpose: a sync command runs inside WebView2's IPC callback on the main thread, and
/// resizing the window from there deadlocks. Off the main thread, window calls are queued instead.
#[tauri::command]
#[specta::specta]
async fn layout(window: Window, hit: State<'_, Arc<HitArea>>, canvas: Size, region: Size) -> Res<()> {
    let (canvas, region) = (window::clamp(canvas.width, canvas.height), window::clamp(region.width, region.height));
    // Not resized to the region there: each resize (and move, under XWayland) lands a frame or more
    // after the last, so the pill jumped and shook as it opened and folded.
    let place = |c| window::place(&window, c, window.state::<Wanted>().get().as_deref());
    #[cfg(target_os = "linux")]
    if window::is_wayland() {
        hit.ensure_canvas(canvas, place)?;
        return window::take_input(&window, canvas, region);
    }
    hit.ensure_canvas(canvas, place)?;
    hit.set_region(region);
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
    let wanted = w.state::<Wanted>().get();
    window::place(w, LogicalSize::new(window::FALLBACK.width, window::FALLBACK.height), wanted.as_deref())?;
    let island = window::native(w)?;
    window::place(w, LogicalSize::new(island.width, island.height), wanted.as_deref())?;
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
            app.manage(Wanted(RwLock::new(screens::wanted(&settings::current(app)))));
            watch_screens(app)?;
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
