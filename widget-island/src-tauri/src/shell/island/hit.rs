//! Click-through outside the pill. The window keeps one fixed size, so it is never moved or
//! resized mid-animation; a thread hit-tests the cursor and toggles passthrough instead.

use std::{
    io,
    sync::{Arc, Mutex, RwLock},
    thread,
    time::Duration,
};

use tauri::{LogicalSize, Runtime, Window};

use super::window::Placement;
use crate::Res;

pub const POLL: Duration = Duration::from_millis(16);

/// Extra logical pixels around the pill that still count as inside, so the page always sees
/// the pointer leave the pill before the window turns click-through.
pub const MARGIN: f64 = 6.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        (self.left..self.right).contains(&x) && (self.top..self.bottom).contains(&y)
    }
}

/// The pill's area in desktop pixels: centered horizontally at the top of the placed window.
pub fn region_rect(p: Placement, region: LogicalSize<f64>, margin: f64) -> Rect {
    let w = (region.width + 2.0 * margin) * p.scale;
    let h = (region.height + margin) * p.scale;
    let left = p.origin.x as f64 + (p.size.width as f64 - w) / 2.0;
    let top = p.origin.y as f64;
    Rect { left, top, right: left + w, bottom: top + h }
}

#[derive(Debug, Default)]
pub struct HitArea {
    canvas: Mutex<Option<(LogicalSize<f64>, Placement)>>,
    region: RwLock<Option<Rect>>,
    tracking: Mutex<bool>,
}

impl HitArea {
    /// Places the window at `canvas` the first time (or when it changes) and returns where it is.
    pub fn ensure_canvas(&self, canvas: LogicalSize<f64>, place: impl FnOnce(LogicalSize<f64>) -> Res<Placement>) -> Res<Placement> {
        let mut current = self.canvas.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((size, placed)) = *current
            && size == canvas
        {
            return Ok(placed);
        }
        let placed = place(canvas)?;
        *current = Some((canvas, placed));
        Ok(placed)
    }

    /// Starts the tracker once. It must start after the event loop runs: it calls into the window
    /// from another thread, and those calls wait on the event loop.
    pub fn ensure_tracking(self: &Arc<Self>, start: impl FnOnce(Arc<Self>) -> io::Result<()>) -> io::Result<()> {
        let mut started = self.tracking.lock().unwrap_or_else(|e| e.into_inner());
        if !*started {
            start(Arc::clone(self))?;
            *started = true;
        }
        Ok(())
    }

    pub fn set_region(&self, rect: Rect) {
        *self.region.write().unwrap_or_else(|e| e.into_inner()) = Some(rect);
    }

    pub fn region(&self) -> Option<Rect> {
        *self.region.read().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn track<R: Runtime>(window: Window<R>, area: Arc<HitArea>) -> io::Result<()> {
    thread::Builder::new().name("hit-test".into()).spawn(move || {
        let mut passthrough = None;
        loop {
            thread::sleep(POLL);
            let (Some(rect), Ok(cursor)) = (area.region(), window.cursor_position()) else { continue };
            let next = !rect.contains(cursor.x, cursor.y);
            if passthrough != Some(next) && window.set_ignore_cursor_events(next).is_ok() {
                passthrough = Some(next);
            }
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use tauri::{PhysicalPosition, PhysicalSize};

    use super::*;

    const PLACED: Placement =
        Placement { origin: PhysicalPosition { x: 100, y: 0 }, size: PhysicalSize { width: 1000, height: 400 }, scale: 2.0 };

    #[test]
    fn region_is_top_centered_and_scaled() {
        let r = region_rect(PLACED, LogicalSize::new(200.0, 32.0), 0.0);
        assert_eq!(r, Rect { left: 100.0 + 300.0, top: 0.0, right: 100.0 + 700.0, bottom: 64.0 });
    }

    #[test]
    fn margin_grows_sides_and_bottom_only() {
        let r = region_rect(PLACED, LogicalSize::new(200.0, 32.0), 5.0);
        assert_eq!(r, Rect { left: 390.0, top: 0.0, right: 810.0, bottom: 74.0 });
    }

    #[test]
    fn contains_is_half_open() {
        let r = Rect { left: 0.0, top: 0.0, right: 10.0, bottom: 10.0 };
        assert!(r.contains(0.0, 9.9));
        assert!(!r.contains(10.0, 5.0));
    }

    #[test]
    fn starts_tracking_once() {
        let area = Arc::new(HitArea::default());
        let starts = Cell::new(0);
        for _ in 0..3 {
            area.ensure_tracking(|_| {
                starts.set(starts.get() + 1);
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(starts.get(), 1);
    }

    #[test]
    fn places_canvas_only_when_it_changes() {
        let area = HitArea::default();
        let calls = Cell::new(0);
        let place = |_| {
            calls.set(calls.get() + 1);
            Ok(PLACED)
        };
        let size = LogicalSize::new(472.0, 204.0);
        area.ensure_canvas(size, place).unwrap();
        area.ensure_canvas(size, place).unwrap();
        area.ensure_canvas(LogicalSize::new(500.0, 204.0), place).unwrap();
        assert_eq!(calls.get(), 2);
    }
}
