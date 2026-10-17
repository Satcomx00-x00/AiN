//! Placement of the island window: flush top-center, above everything, per platform.

use serde::Serialize;
use specta::Type;
use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, Runtime, Window};

use crate::{Error, Res};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Island {
    pub width: f64,
    pub height: f64,
    pub has_notch: bool,
}

pub const FALLBACK: Island = Island { width: 200.0, height: 32.0, has_notch: false };
const MAX: LogicalSize<f64> = LogicalSize { width: 720.0, height: 400.0 };

pub fn top_center(origin: PhysicalPosition<i32>, area: PhysicalSize<u32>, win: PhysicalSize<u32>) -> PhysicalPosition<i32> {
    PhysicalPosition::new(origin.x + (area.width.saturating_sub(win.width) / 2) as i32, origin.y)
}

pub fn clamp(width: f64, height: f64) -> LogicalSize<f64> {
    LogicalSize::new(width.clamp(1.0, MAX.width), height.clamp(1.0, MAX.height))
}

/// Wayland can't report the global cursor, so there the window is resized instead of hit-tested,
/// and the compositor keeps it anchored to the top edge.
pub fn is_wayland() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Where the window ended up, in desktop pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub origin: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
    pub scale: f64,
}

pub fn place<R: Runtime>(w: &Window<R>, size: LogicalSize<f64>) -> Res<Placement> {
    if is_wayland() {
        // GTK sizes a non-resizable window to at least its content's natural size, 200×200 for the
        // webview, which left an invisible strip under the folded pill taking clicks. Resizable,
        // with min = max, it takes the size asked for and still can't be resized by hand.
        w.set_resizable(true)?;
        w.set_max_size(None::<LogicalSize<f64>>)?;
        w.set_min_size(Some(size))?;
        w.set_max_size(Some(size))?;
    }
    w.set_size(size)?;
    // An unmapped window has no current monitor, and GDK has no primary one on Wayland (GNOME):
    // fall back to the first monitor listed.
    let m = match w.current_monitor()?.or(w.primary_monitor()?) {
        Some(m) => m,
        None => w.available_monitors()?.into_iter().next().ok_or_else(|| Error::msg("no monitor available"))?,
    };
    let (scale, physical) = (m.scale_factor(), size.to_physical(m.scale_factor()));
    let origin = top_center(*m.position(), *m.size(), physical);
    if !is_wayland() {
        w.set_position(origin)?;
    }
    Ok(Placement { origin, size: physical, scale })
}

#[cfg(target_os = "macos")]
pub fn native<R: Runtime>(w: &Window<R>) -> Res<Island> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior as B};
    const ABOVE_MENU_BAR: isize = 1000;
    // SAFETY: called from setup() on the main thread; Tauri owns a live NSWindow.
    let ns = unsafe { &*(w.ns_window()? as *const NSWindow) };
    ns.setLevel(ABOVE_MENU_BAR);
    ns.setCollectionBehavior(B::CanJoinAllSpaces | B::FullScreenAuxiliary | B::Stationary | B::IgnoresCycle);
    let Some(s) = ns.screen() else { return Ok(FALLBACK) };
    let (f, l, r) = (s.frame(), s.auxiliaryTopLeftArea(), s.auxiliaryTopRightArea());
    Ok(match l.size.width > 0.0 {
        true => Island { width: f.size.width - l.size.width - r.size.width, height: l.size.height, has_notch: true },
        false => FALLBACK,
    })
}

#[cfg(target_os = "linux")]
pub fn native<R: Runtime>(w: &Window<R>) -> Res<Island> {
    use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
    if is_wayland() && gtk_layer_shell::is_supported() {
        let g = w.gtk_window()?;
        g.init_layer_shell();
        g.set_layer(Layer::Overlay);
        g.set_anchor(Edge::Top, true);
        g.set_keyboard_mode(KeyboardMode::None);
        g.set_exclusive_zone(-1);
    }
    Ok(FALLBACK)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn native<R: Runtime>(_: &Window<R>) -> Res<Island> {
    Ok(FALLBACK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flush_top_center_on_offset_monitor() {
        let p = top_center(PhysicalPosition::new(1920, 0), PhysicalSize::new(2560, 1440), PhysicalSize::new(400, 64));
        assert_eq!(p, PhysicalPosition::new(1920 + 1080, 0));
    }

    #[test]
    fn keeps_monitor_y_origin() {
        let p = top_center(PhysicalPosition::new(0, -1080), PhysicalSize::new(1920, 1080), PhysicalSize::new(200, 32));
        assert_eq!(p, PhysicalPosition::new(860, -1080));
    }

    #[test]
    fn clamps_oversized_window() {
        let p = top_center(PhysicalPosition::new(0, 0), PhysicalSize::new(100, 100), PhysicalSize::new(300, 50));
        assert_eq!(p, PhysicalPosition::new(0, 0));
    }

    #[test]
    fn clamps_requested_size() {
        assert_eq!(clamp(0.0, 9999.0), LogicalSize::new(1.0, MAX.height));
    }
}
