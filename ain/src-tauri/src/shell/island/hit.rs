//! Click-through outside the pill. The window keeps one fixed size, so it is never moved or
//! resized mid-animation; a thread hit-tests the cursor and toggles passthrough instead.

use std::{
    io,
    sync::{Arc, Mutex, RwLock},
    thread,
    time::{Duration, Instant},
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

/// Keeps the pill hidden until the cursor rests on its spot (top center) for `dwell`; once shown,
/// it hides again when the cursor has been away for `grace`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AutoHide {
    pub dwell: Duration,
    pub grace: Duration,
}

/// Whether the pill is shown, and since when the cursor has been where it would change that.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reveal {
    pub shown: bool,
    since: Option<Instant>,
}

impl Default for Reveal {
    fn default() -> Self {
        Self { shown: true, since: None }
    }
}

impl Reveal {
    /// The next state, given whether the cursor is on the pill's spot now. Without a rule, always shown.
    pub fn step(self, rule: Option<AutoHide>, inside: bool, now: Instant) -> Self {
        let Some(rule) = rule else { return Self::default() };
        // Hidden, the cursor must stay on the spot to show it; shown, it must stay away to hide it.
        let (toward, wait) = if self.shown { (!inside, rule.grace) } else { (inside, rule.dwell) };
        if !toward {
            return Self { shown: self.shown, since: None };
        }
        let since = self.since.unwrap_or(now);
        match now.duration_since(since) >= wait {
            true => Self { shown: !self.shown, since: None },
            false => Self { shown: self.shown, since: Some(since) },
        }
    }
}

#[derive(Debug, Default)]
pub struct HitArea {
    canvas: Mutex<Option<(LogicalSize<f64>, Placement)>>,
    region: RwLock<Option<Rect>>,
    /// The pill's logical size, so its area can follow the window to another screen.
    region_size: Mutex<Option<LogicalSize<f64>>>,
    tracking: Mutex<bool>,
    auto_hide: RwLock<Option<AutoHide>>,
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

    /// Places the window again at its canvas, e.g. on another screen, and moves the pill's area
    /// with it. Nothing to do before the first `ensure_canvas`.
    pub fn relocate(&self, place: impl FnOnce(LogicalSize<f64>) -> Res<Placement>) -> Res<()> {
        let mut current = self.canvas.lock().unwrap_or_else(|e| e.into_inner());
        let Some((size, _)) = *current else { return Ok(()) };
        let placed = place(size)?;
        *current = Some((size, placed));
        if let Some(region) = *self.region_size.lock().unwrap_or_else(|e| e.into_inner()) {
            *self.region.write().unwrap_or_else(|e| e.into_inner()) = Some(region_rect(placed, region, MARGIN));
        }
        Ok(())
    }

    /// The pill is now `region` (logical) at the top center of the placed window.
    pub fn set_region(&self, region: LogicalSize<f64>) {
        let current = self.canvas.lock().unwrap_or_else(|e| e.into_inner());
        *self.region_size.lock().unwrap_or_else(|e| e.into_inner()) = Some(region);
        *self.region.write().unwrap_or_else(|e| e.into_inner()) = current.map(|(_, placed)| region_rect(placed, region, MARGIN));
    }

    pub fn region(&self) -> Option<Rect> {
        *self.region.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_auto_hide(&self, rule: Option<AutoHide>) {
        *self.auto_hide.write().unwrap_or_else(|e| e.into_inner()) = rule;
    }

    pub fn auto_hide(&self) -> Option<AutoHide> {
        *self.auto_hide.read().unwrap_or_else(|e| e.into_inner())
    }
}

/// `on_reveal` hears each time the auto-hide rule shows or hides the pill. A hidden pill lets
/// every click through.
pub fn track<R: Runtime>(window: Window<R>, area: Arc<HitArea>, on_reveal: impl Fn(bool) + Send + 'static) -> io::Result<()> {
    thread::Builder::new().name("hit-test".into()).spawn(move || {
        let mut passthrough = None;
        let mut reveal = Reveal::default();
        loop {
            thread::sleep(POLL);
            let (Some(rect), Ok(cursor)) = (area.region(), window.cursor_position()) else { continue };
            let inside = rect.contains(cursor.x, cursor.y);
            let next = reveal.step(area.auto_hide(), inside, Instant::now());
            if next.shown != reveal.shown {
                on_reveal(next.shown);
            }
            reveal = next;
            let next = !(inside && reveal.shown);
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

    const RULE: AutoHide = AutoHide { dwell: Duration::from_millis(500), grace: Duration::from_millis(800) };

    /// Runs `steps` of (ms since start, cursor on the spot) and returns whether the pill shows after each.
    fn run(rule: Option<AutoHide>, steps: &[(u64, bool)]) -> Vec<bool> {
        let start = Instant::now();
        let mut r = Reveal::default();
        steps
            .iter()
            .map(|&(ms, inside)| {
                r = r.step(rule, inside, start + Duration::from_millis(ms));
                r.shown
            })
            .collect()
    }

    #[test]
    fn without_auto_hide_the_pill_always_shows() {
        assert_eq!(run(None, &[(0, false), (5000, false), (6000, true)]), [true, true, true]);
    }

    #[test]
    fn hides_once_the_cursor_has_been_away_for_the_grace_time() {
        assert_eq!(run(Some(RULE), &[(0, false), (700, false), (800, false)]), [true, true, false]);
    }

    #[test]
    fn shows_only_after_resting_on_the_spot_for_the_dwell_time() {
        let steps = [(0, false), (800, false), (900, true), (1300, true), (1400, true)];
        assert_eq!(run(Some(RULE), &steps), [true, false, false, false, true]);
    }

    #[test]
    fn passing_over_the_spot_restarts_the_wait() {
        let steps = [(0, false), (800, false), (900, true), (1300, false), (1400, true), (1800, true), (1900, true)];
        assert_eq!(run(Some(RULE), &steps), [true, false, false, false, false, false, true]);
    }

    #[test]
    fn coming_back_within_the_grace_time_keeps_it_shown() {
        let steps = [(0, false), (700, true), (1400, false), (2000, true), (2700, false)];
        assert_eq!(run(Some(RULE), &steps), [true, true, true, true, true]);
    }

    #[test]
    fn turning_auto_hide_off_shows_it_at_once() {
        let start = Instant::now();
        let hidden = Reveal::default().step(Some(RULE), false, start).step(Some(RULE), false, start + RULE.grace);
        assert!(!hidden.shown);
        assert!(hidden.step(None, false, start + RULE.grace).shown);
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

    #[test]
    fn relocating_moves_the_pill_area_with_the_window() {
        let area = HitArea::default();
        area.relocate(|_| unreachable!("nothing placed yet")).unwrap();
        let size = LogicalSize::new(472.0, 204.0);
        area.ensure_canvas(size, |_| Ok(PLACED)).unwrap();
        area.set_region(LogicalSize::new(200.0, 32.0));
        let moved = Placement { origin: PhysicalPosition { x: 3000, y: 0 }, ..PLACED };
        area.relocate(|c| {
            assert_eq!(c, size);
            Ok(moved)
        })
        .unwrap();
        assert_eq!(area.region(), Some(region_rect(moved, LogicalSize::new(200.0, 32.0), MARGIN)));
    }
}
