//! The window that shows notifications as toasts, in a corner of the screen the island is on. It
//! never takes the focus, so a toast can't steal what the user is typing. The island tells the
//! page what to show (a JavaScript event); the page sizes and places the window here.

use serde::Deserialize;
use specta::Type;
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
    plugin::TauriPlugin,
};

use crate::{Error, Res};

const LABEL: &str = "toasts";
/// The island's window, whose screen the toasts go on.
const ISLAND: &str = "widget";
/// Room between the toasts and the screen's edges (and the taskbar, or GNOME's top bar), in logical px.
const MARGIN: f64 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Corner {
    fn top(self) -> bool {
        matches!(self, Corner::TopLeft | Corner::TopRight)
    }

    fn left(self) -> bool {
        matches!(self, Corner::TopLeft | Corner::BottomLeft)
    }
}

/// Where a window of `size` goes in `corner` of the work area (`origin`, `area`), `margin` from its edges.
pub fn corner_position(
    origin: PhysicalPosition<i32>,
    area: PhysicalSize<u32>,
    size: PhysicalSize<u32>,
    margin: u32,
    corner: Corner,
) -> PhysicalPosition<i32> {
    // From the near edge, or the far one; never off the area's start when the window is too big.
    let near = |room: u32, used: u32| margin.min(room.saturating_sub(used)) as i32;
    let far = |room: u32, used: u32| room.saturating_sub(used).saturating_sub(margin) as i32;
    let x = if corner.left() { near(area.width, size.width) } else { far(area.width, size.width) };
    let y = if corner.top() { near(area.height, size.height) } else { far(area.height, size.height) };
    PhysicalPosition::new(origin.x + x, origin.y + y)
}

/// The toast window, made (hidden) the first time.
fn window(app: &AppHandle) -> Res<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("toasts.html".into()))
        .title("AiN notifications")
        .inner_size(1.0, 1.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
    #[cfg(target_os = "linux")]
    linux::prepare(&w)?;
    Ok(w)
}

/// Makes the toast window, hidden, so its page can listen for what to show.
#[tauri::command]
#[specta::specta]
async fn ensure(app: AppHandle) -> Res<()> {
    window(&app).map(|_| ())
}

/// Sizes the toast window to its toasts (`width` × `height`, logical px) and puts it in `corner`
/// of the island's screen, above the taskbar; a `height` of 0 hides it. Async: window calls from
/// the IPC callback's thread deadlock on Windows.
#[tauri::command]
#[specta::specta]
async fn place(window: WebviewWindow, corner: Corner, width: f64, height: f64) -> Res<()> {
    if height <= 0.0 || width <= 0.0 {
        window.hide()?;
        return Ok(());
    }
    let island = window.app_handle().get_webview_window(ISLAND);
    let monitor = match island.as_ref().map(|w| w.current_monitor()).transpose()?.flatten().or(window.primary_monitor()?) {
        Some(m) => m,
        None => window.available_monitors()?.into_iter().next().ok_or_else(|| Error::msg("no monitor available"))?,
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let size = LogicalSize::new(width, height.min(work.size.height as f64 / scale - 2.0 * MARGIN)).to_physical::<u32>(scale);
    window.set_size(size)?;
    #[cfg(target_os = "linux")]
    if linux::anchor(&window, corner, MARGIN)? {
        window.show()?;
        return Ok(());
    }
    window.set_position(corner_position(work.position, work.size, size, (MARGIN * scale).round() as u32, corner))?;
    window.show()?;
    Ok(())
}

/// Wayland desktops with layer-shell (KDE, Sway…) place windows themselves: there the window is a
/// layer anchored to the corner. GNOME has none, and runs it through XWayland, placed as anywhere else.
#[cfg(target_os = "linux")]
mod linux {
    use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
    use tauri::{Runtime, WebviewWindow};

    use super::Corner;
    use crate::Res;

    fn layered() -> bool {
        crate::shell::island::is_wayland_surface() && gtk_layer_shell::is_supported()
    }

    pub fn prepare<R: Runtime>(w: &WebviewWindow<R>) -> Res<()> {
        if layered() {
            let g = w.gtk_window()?;
            g.init_layer_shell();
            g.set_layer(Layer::Overlay);
            g.set_keyboard_mode(KeyboardMode::None);
        }
        Ok(())
    }

    /// Anchors the layer to `corner`; false where the window isn't a layer (it is placed instead).
    pub fn anchor<R: Runtime>(w: &WebviewWindow<R>, corner: Corner, margin: f64) -> Res<bool> {
        if !layered() {
            return Ok(false);
        }
        let g = w.gtk_window()?;
        let m = margin.round() as i32;
        for (edge, on) in
            [(Edge::Top, corner.top()), (Edge::Bottom, !corner.top()), (Edge::Left, corner.left()), (Edge::Right, !corner.left())]
        {
            g.set_anchor(edge, on);
            g.set_layer_shell_margin(edge, if on { m } else { 0 });
        }
        Ok(true)
    }
}

crate::ipc::toasts!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|_| Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: PhysicalPosition<i32> = PhysicalPosition { x: 1920, y: 0 };
    const AREA: PhysicalSize<u32> = PhysicalSize { width: 2560, height: 1400 };
    const TOASTS: PhysicalSize<u32> = PhysicalSize { width: 384, height: 200 };

    #[test]
    fn puts_toasts_in_each_corner_of_the_work_area() {
        assert_eq!(corner_position(ORIGIN, AREA, TOASTS, 24, Corner::TopLeft), PhysicalPosition::new(1920 + 24, 24));
        assert_eq!(corner_position(ORIGIN, AREA, TOASTS, 24, Corner::TopRight), PhysicalPosition::new(1920 + 2560 - 384 - 24, 24));
        assert_eq!(corner_position(ORIGIN, AREA, TOASTS, 24, Corner::BottomLeft), PhysicalPosition::new(1920 + 24, 1400 - 200 - 24));
        assert_eq!(
            corner_position(ORIGIN, AREA, TOASTS, 24, Corner::BottomRight),
            PhysicalPosition::new(1920 + 2560 - 384 - 24, 1400 - 200 - 24)
        );
    }

    #[test]
    fn keeps_a_too_big_window_on_screen() {
        let small = PhysicalSize::new(300, 150);
        assert_eq!(corner_position(PhysicalPosition::new(0, 0), small, TOASTS, 24, Corner::BottomRight), PhysicalPosition::new(0, 0));
        assert_eq!(corner_position(PhysicalPosition::new(0, 0), small, TOASTS, 24, Corner::TopLeft), PhysicalPosition::new(0, 0));
    }

    #[test]
    fn reads_corners_as_the_frontend_writes_them() {
        assert_eq!(serde_json::from_str::<Corner>("\"bottom-left\"").unwrap(), Corner::BottomLeft);
        assert!(serde_json::from_str::<Corner>("\"middle\"").is_err());
    }
}
