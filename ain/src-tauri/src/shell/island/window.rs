//! Placement of the island window: flush top-center, above everything, per platform.

use serde::Serialize;
use specta::Type;
use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, Runtime, Window};

use super::screens;
use crate::{Error, Res};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Island {
    pub width: f64,
    pub height: f64,
    pub has_notch: bool,
}

pub const FALLBACK: Island = Island { width: 200.0, height: 32.0, has_notch: false };
/// Wide enough for bubbles beside the widest pill (geometry.ts `bubbleCanvas`).
const MAX: LogicalSize<f64> = LogicalSize { width: 1280.0, height: 400.0 };

pub fn top_center(origin: PhysicalPosition<i32>, area: PhysicalSize<u32>, win: PhysicalSize<u32>) -> PhysicalPosition<i32> {
    PhysicalPosition::new(origin.x + (area.width.saturating_sub(win.width) / 2) as i32, origin.y)
}

pub fn clamp(width: f64, height: f64) -> LogicalSize<f64> {
    LogicalSize::new(width.clamp(1.0, MAX.width), height.clamp(1.0, MAX.height))
}

/// Wayland can't report the global cursor, even to an XWayland window, so there the window's input
/// is shaped to the pill instead of hit-tested.
pub fn is_wayland() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// The window is a Wayland surface, which only the compositor (through layer-shell) can place.
/// Through XWayland it is an X11 window we place ourselves, though the session is still Wayland.
pub fn is_wayland_surface() -> bool {
    #[cfg(target_os = "linux")]
    let xwayland = crate::platform::linux::xwayland();
    #[cfg(not(target_os = "linux"))]
    let xwayland = false;
    is_wayland() && !xwayland
}

/// Where the window ended up, in desktop pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub origin: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
    pub scale: f64,
}

/// Places the window flush top-center on the screen `screens::pick` chooses for `wanted`.
pub fn place<R: Runtime>(w: &Window<R>, size: LogicalSize<f64>, wanted: Option<&str>) -> Res<Placement> {
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
    let monitors = w.available_monitors()?;
    let index = screens::pick(&screens::describe(&monitors, w.primary_monitor()?.as_ref()), wanted)
        .ok_or_else(|| Error::msg("no monitor available"))?;
    let m = &monitors[index];
    let (scale, physical) = (m.scale_factor(), size.to_physical(m.scale_factor()));
    let origin = top_center(*m.position(), *m.size(), physical);
    match is_wayland_surface() {
        true => put_on(w, index)?,
        false => w.set_position(origin)?,
    }
    Ok(Placement { origin, size: physical, scale })
}

/// Asks the compositor to show the layer surface on the `index`th monitor, which is GDK's own
/// numbering, the one `available_monitors` lists in. Before layer-shell is set up, it waits for `native`.
#[cfg(target_os = "linux")]
fn put_on<R: Runtime>(w: &Window<R>, index: usize) -> Res<()> {
    use gtk_layer_shell::LayerShell;
    let window = w.clone();
    w.run_on_main_thread(move || {
        let monitor = gtk::gdk::Display::default().and_then(|d| d.monitor(i32::try_from(index).ok()?));
        if let (Ok(g), Some(m)) = (window.gtk_window(), monitor)
            && g.is_layer_window()
        {
            g.set_monitor(&m);
        }
    })?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn put_on<R: Runtime>(_: &Window<R>, _: usize) -> Res<()> {
    Ok(())
}

/// The part of the window at `canvas` that takes input: `region`, centered at the top. Clicks
/// anywhere else go through to what's under the window, which keeps its size and place.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn input_rect(canvas: LogicalSize<f64>, region: LogicalSize<f64>) -> (i32, i32, i32, i32) {
    let (width, height) = (region.width.min(canvas.width).ceil(), region.height.min(canvas.height).ceil());
    (((canvas.width - width) / 2.0).floor() as i32, 0, width as i32, height as i32)
}

/// An `area` (x, y, width, height, logical px) of the window at `canvas`, in whole pixels and
/// within it; none when nothing of it is left.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn area_rect(canvas: LogicalSize<f64>, (x, y, width, height): (f64, f64, f64, f64)) -> Option<(i32, i32, i32, i32)> {
    let (left, top) = (x.max(0.0).floor(), y.max(0.0).floor());
    let (right, bottom) = ((x + width).min(canvas.width).ceil(), (y + height).min(canvas.height).ceil());
    (right > left && bottom > top).then_some((left as i32, top as i32, (right - left) as i32, (bottom - top) as i32))
}

/// Shapes the window's input to `input_rect` and the `extra` areas. GDK makes it the X11 window's
/// input shape, or the Wayland surface's input region.
#[cfg(target_os = "linux")]
pub fn take_input<R: Runtime>(
    w: &Window<R>,
    canvas: LogicalSize<f64>,
    region: LogicalSize<f64>,
    extra: &[(f64, f64, f64, f64)],
) -> Res<()> {
    use gtk::{cairo, prelude::WidgetExt};
    let (x, y, width, height) = input_rect(canvas, region);
    let more: Vec<_> = extra.iter().filter_map(|&a| area_rect(canvas, a)).collect();
    let window = w.clone();
    w.run_on_main_thread(move || {
        let shaped = window.gtk_window().map(|g| {
            g.window().map(|gdk| {
                let input = cairo::Region::create_rectangle(&cairo::RectangleInt::new(x, y, width, height));
                for &(x, y, width, height) in &more {
                    let _ = input.union_rectangle(&cairo::RectangleInt::new(x, y, width, height));
                }
                gdk.input_shape_combine_region(&input, 0, 0);
            })
        });
        if !matches!(shaped, Ok(Some(()))) {
            eprintln!("island: could not shape the window's input");
        }
    })?;
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn native<R: Runtime>(w: &Window<R>) -> Res<Island> {
    use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
    if is_wayland_surface() && gtk_layer_shell::is_supported() {
        let g = w.gtk_window()?;
        g.init_layer_shell();
        g.set_layer(Layer::Overlay);
        g.set_anchor(Edge::Top, true);
        g.set_keyboard_mode(KeyboardMode::None);
        g.set_exclusive_zone(-1);
    }
    Ok(FALLBACK)
}

#[cfg(not(target_os = "linux"))]
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
    fn input_is_top_centered_in_the_canvas() {
        assert_eq!(input_rect(LogicalSize::new(472.0, 384.0), LogicalSize::new(220.0, 32.0)), (126, 0, 220, 32));
        assert_eq!(input_rect(LogicalSize::new(472.0, 384.0), LogicalSize::new(219.5, 31.2)), (126, 0, 220, 32));
        assert_eq!(input_rect(LogicalSize::new(200.0, 32.0), LogicalSize::new(472.0, 384.0)), (0, 0, 200, 32));
    }

    #[test]
    fn areas_are_whole_pixels_within_the_canvas() {
        let canvas = LogicalSize::new(1000.0, 400.0);
        assert_eq!(area_rect(canvas, (10.4, 2.6, 340.2, 100.0)), Some((10, 2, 341, 101)));
        assert_eq!(area_rect(canvas, (900.0, 300.0, 340.0, 200.0)), Some((900, 300, 100, 100)));
        assert_eq!(area_rect(canvas, (1200.0, 0.0, 40.0, 40.0)), None);
    }

    #[test]
    fn clamps_requested_size() {
        assert_eq!(clamp(0.0, 9999.0), LogicalSize::new(1.0, MAX.height));
    }
}
