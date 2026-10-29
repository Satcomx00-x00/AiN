//! Zones as geometry: a layout's zones as fractions of a screen, fitted to a work area with even
//! spacing, and the questions dragging and the shortcuts ask of them (which zone is under the
//! pointer, which one a window fills, which comes next).

use serde::{Deserialize, Serialize};
use specta::Type;

/// The most zones a layout has: the zone picker numbers them 1 to 9.
pub const MAX_ZONES: u32 = 9;

/// A rectangle in the desktop's coordinates, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }

    pub const fn right(&self) -> i32 {
        self.x + self.w
    }

    pub const fn bottom(&self) -> i32 {
        self.y + self.h
    }

    pub const fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }

    pub const fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }

    fn area(&self) -> i64 {
        i64::from(self.w.max(0)) * i64::from(self.h.max(0))
    }

    fn overlap(&self, other: &Rect) -> i64 {
        let w = self.right().min(other.right()) - self.x.max(other.x);
        let h = self.bottom().min(other.bottom()) - self.y.max(other.y);
        if w <= 0 || h <= 0 { 0 } else { i64::from(w) * i64::from(h) }
    }

    /// The smallest rectangle holding both.
    pub fn union(&self, other: &Rect) -> Rect {
        let (x, y) = (self.x.min(other.x), self.y.min(other.y));
        Rect::new(x, y, self.right().max(other.right()) - x, self.bottom().max(other.bottom()) - y)
    }

    /// The square of how far a point is from the rectangle; 0 inside it.
    fn distance2(&self, x: i32, y: i32) -> i64 {
        let dx = i64::from((self.x - x).max(x - self.right() + 1).max(0));
        let dy = i64::from((self.y - y).max(y - self.bottom() + 1).max(0));
        dx * dx + dy * dy
    }
}

/// A zone as a fraction of the screen's work area.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
pub struct Frac {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Frac {
    const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    const fn transposed(self) -> Self {
        Self { x: self.y, y: self.x, w: self.h, h: self.w }
    }
}

/// The layouts, as PowerToys' FancyZones has them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Template {
    /// Side by side.
    Columns,
    /// One above another.
    Rows,
    /// Rows of columns, the last row's zones wider when they don't fill it.
    Grid,
    /// A wide zone in the middle, the others in narrow columns on each side.
    PriorityGrid,
    /// Overlapping zones, each a little further down and to the right.
    Focus,
}

/// A layout's zones, in reading order: left to right, then top to bottom. On a portrait screen
/// (when `portrait` is true) side-by-side layouts turn to stack instead.
pub fn fractions(template: Template, count: u32, portrait: bool) -> Vec<Frac> {
    let n = count.clamp(1, MAX_ZONES) as usize;
    let even = |i: usize, of: usize| (i as f64 / of as f64, 1.0 / of as f64);
    let zones: Vec<Frac> = match template {
        Template::Columns => (0..n).map(|i| even(i, n)).map(|(x, w)| Frac::new(x, 0.0, w, 1.0)).collect(),
        Template::Rows => (0..n).map(|i| even(i, n)).map(|(y, h)| Frac::new(0.0, y, 1.0, h)).collect(),
        Template::Grid => {
            let cols = (n as f64).sqrt().ceil() as usize;
            let rows = n.div_ceil(cols);
            (0..rows)
                .flat_map(|r| {
                    let in_row = if r + 1 == rows { n - cols * (rows - 1) } else { cols };
                    let (y, h) = even(r, rows);
                    (0..in_row).map(move |c| {
                        let (x, w) = even(c, in_row);
                        Frac::new(x, y, w, h)
                    })
                })
                .collect()
        }
        Template::PriorityGrid => match n {
            1 => vec![Frac::new(0.0, 0.0, 1.0, 1.0)],
            2 => vec![Frac::new(0.0, 0.0, 2.0 / 3.0, 1.0), Frac::new(2.0 / 3.0, 0.0, 1.0 / 3.0, 1.0)],
            _ => {
                let (left, right) = ((n - 1).div_ceil(2), (n - 1) / 2);
                let side = |x: f64, count: usize| (0..count).map(move |i| even(i, count)).map(move |(y, h)| Frac::new(x, y, 0.25, h));
                let center = Frac::new(0.25, 0.0, if right == 0 { 0.75 } else { 0.5 }, 1.0);
                side(0.0, left).chain([center]).chain(side(0.75, right)).collect()
            }
        },
        Template::Focus => {
            let step = if n > 1 { 0.3 / (n - 1) as f64 } else { 0.0 };
            let start = if n > 1 { 0.1 } else { 0.2 };
            (0..n).map(|i| start + step * i as f64).map(|at| Frac::new(at, at, 0.6, 0.6)).collect()
        }
    };
    match portrait && template != Template::Focus {
        true => zones.into_iter().map(Frac::transposed).collect(),
        false => zones,
    }
}

/// The zones in `area`, with `spacing` between them and around them. Neighbours share their
/// edges exactly, whatever the rounding.
pub fn fit(area: Rect, zones: &[Frac], spacing: i32) -> Vec<Rect> {
    let spacing = spacing.max(0);
    let x = |f: f64| area.x + (f * f64::from(area.w)).round() as i32;
    let y = |f: f64| area.y + (f * f64::from(area.h)).round() as i32;
    // An edge on the work area's border gets the whole spacing; one between zones, half of it on
    // each side (the odd pixel after it).
    let start = |edge: i32, border: i32| if edge == border { spacing } else { spacing - spacing / 2 };
    let end = |edge: i32, border: i32| if edge == border { spacing } else { spacing / 2 };
    zones
        .iter()
        .map(|f| {
            let (left, top, right, bottom) = (x(f.x), y(f.y), x(f.x + f.w), y(f.y + f.h));
            let (l, t) = (left + start(left, area.x), top + start(top, area.y));
            let (r, b) = (right - end(right, area.right()), bottom - end(bottom, area.bottom()));
            Rect::new(l, t, (r - l).max(1), (b - t).max(1))
        })
        .collect()
}

/// The zone under a point: of those holding it, the one whose center is nearest (zones may
/// overlap); in the spacing between zones, the nearest within `reach`.
pub fn hit(zones: &[Rect], x: i32, y: i32, reach: i32) -> Option<usize> {
    let d2 = |r: &Rect| {
        let (cx, cy) = r.center();
        i64::from(cx - x).pow(2) + i64::from(cy - y).pow(2)
    };
    let inside = zones.iter().enumerate().filter(|(_, z)| z.contains(x, y)).min_by_key(|(_, z)| d2(z)).map(|(i, _)| i);
    inside.or_else(|| {
        let reach = i64::from(reach.max(0)).pow(2);
        zones.iter().enumerate().map(|(i, z)| (i, z.distance2(x, y))).filter(|(_, d)| *d <= reach).min_by_key(|(_, d)| *d).map(|(i, _)| i)
    })
}

/// The zones a drag from zone `a` to zone `b` spans: those inside the rectangle holding both.
pub fn span(zones: &[Rect], a: usize, b: usize) -> Vec<usize> {
    let (Some(za), Some(zb)) = (zones.get(a), zones.get(b)) else { return Vec::new() };
    let bounds = za.union(zb);
    let mut out: Vec<usize> = zones.iter().enumerate().filter(|(_, z)| z.overlap(&bounds) * 2 > z.area()).map(|(i, _)| i).collect();
    out.sort_unstable();
    out
}

/// The rectangle holding the zones at `indexes`.
pub fn bounds(zones: &[Rect], indexes: &[usize]) -> Option<Rect> {
    indexes.iter().filter_map(|&i| zones.get(i)).copied().reduce(|a, b| a.union(&b))
}

/// The zone a window is in: the one it fills best, if it covers most of it and little else.
pub fn zone_of(zones: &[Rect], frame: &Rect) -> Option<usize> {
    let fit = |z: &Rect| {
        let shared = z.overlap(frame) as f64;
        let all = (z.area() + frame.area()) as f64 - shared;
        if all > 0.0 { shared / all } else { 0.0 }
    };
    zones.iter().enumerate().map(|(i, z)| (i, fit(z))).filter(|(_, f)| *f >= 0.6).max_by(|a, b| a.1.total_cmp(&b.1)).map(|(i, _)| i)
}

/// The screen a rectangle is mostly on, or the first.
pub fn screen_of(areas: &[Rect], frame: &Rect) -> usize {
    areas.iter().enumerate().max_by_key(|(_, a)| a.overlap(frame)).filter(|(_, a)| a.overlap(frame) > 0).map_or(0, |(i, _)| i)
}

/// The screen holding a point, or the nearest one.
pub fn screen_at(areas: &[Rect], x: i32, y: i32) -> Option<usize> {
    areas.iter().enumerate().min_by_key(|(_, a)| a.distance2(x, y)).map(|(i, _)| i)
}

/// Where a window moves on "next zone" (`forward`) or "previous zone": the neighbouring zone of
/// its screen (it starts from the first or last when it isn't in one), and past the end, the
/// first or last zone of the next or previous screen when `across` is on (else around the same
/// screen). `zones[s]` are screen `s`'s zones; returns (screen, zone).
pub fn step(zones: &[Vec<Rect>], screen: usize, frame: &Rect, forward: bool, across: bool) -> Option<(usize, usize)> {
    let count = zones.get(screen)?.len();
    if count == 0 {
        return None;
    }
    let Some(at) = zone_of(&zones[screen], frame) else { return Some((screen, if forward { 0 } else { count - 1 })) };
    let screens = zones.len();
    match (forward, at) {
        (true, at) if at + 1 < count => Some((screen, at + 1)),
        (false, at) if at > 0 => Some((screen, at - 1)),
        _ if !across || screens < 2 => Some((screen, if forward { 0 } else { count - 1 })),
        _ => {
            let next = if forward { (screen + 1) % screens } else { (screen + screens - 1) % screens };
            let last = zones[next].len().checked_sub(1)?;
            Some((next, if forward { 0 } else { last }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect::new(0, 0, 1200, 600);

    fn rounded(zones: &[Frac]) -> Vec<(i32, i32, i32, i32)> {
        let pct = |v: f64| (v * 100.0).round() as i32;
        zones.iter().map(|f| (pct(f.x), pct(f.y), pct(f.w), pct(f.h))).collect()
    }

    #[test]
    fn lays_out_columns_rows_and_grids() {
        assert_eq!(rounded(&fractions(Template::Columns, 3, false)), [(0, 0, 33, 100), (33, 0, 33, 100), (67, 0, 33, 100)]);
        assert_eq!(rounded(&fractions(Template::Rows, 2, false)), [(0, 0, 100, 50), (0, 50, 100, 50)]);
        assert_eq!(rounded(&fractions(Template::Grid, 4, false)), [(0, 0, 50, 50), (50, 0, 50, 50), (0, 50, 50, 50), (50, 50, 50, 50)]);
        // Three: two above, one as wide as the screen below.
        assert_eq!(rounded(&fractions(Template::Grid, 3, false)), [(0, 0, 50, 50), (50, 0, 50, 50), (0, 50, 100, 50)]);
        assert_eq!(fractions(Template::Grid, 9, false).len(), 9);
    }

    #[test]
    fn lays_out_a_priority_grid_around_a_wide_middle() {
        assert_eq!(rounded(&fractions(Template::PriorityGrid, 2, false)), [(0, 0, 67, 100), (67, 0, 33, 100)]);
        assert_eq!(rounded(&fractions(Template::PriorityGrid, 3, false)), [(0, 0, 25, 100), (25, 0, 50, 100), (75, 0, 25, 100)]);
        assert_eq!(
            rounded(&fractions(Template::PriorityGrid, 5, false)),
            [(0, 0, 25, 50), (0, 50, 25, 50), (25, 0, 50, 100), (75, 0, 25, 50), (75, 50, 25, 50)]
        );
    }

    #[test]
    fn stacks_on_portrait_screens_and_keeps_the_count_in_range() {
        assert_eq!(rounded(&fractions(Template::Columns, 2, true)), [(0, 0, 100, 50), (0, 50, 100, 50)]);
        let focus = fractions(Template::Focus, 3, true);
        assert_eq!(focus, fractions(Template::Focus, 3, false), "focus zones don't turn");
        assert!(focus.iter().all(|f| f.x + f.w <= 1.0 && f.y + f.h <= 1.0));
        assert_eq!(fractions(Template::Rows, 0, false).len(), 1);
        assert_eq!(fractions(Template::Rows, 50, false).len(), MAX_ZONES as usize);
    }

    #[test]
    fn spaces_zones_evenly_and_shares_their_edges() {
        let zones = fit(AREA, &fractions(Template::Columns, 3, false), 10);
        assert_eq!(zones, [Rect::new(10, 10, 385, 580), Rect::new(405, 10, 390, 580), Rect::new(805, 10, 385, 580)]);
        let gaps: Vec<i32> = zones.windows(2).map(|w| w[1].x - w[0].right()).collect();
        assert_eq!(gaps, [10, 10]);
        let odd = fit(AREA, &fractions(Template::Columns, 2, false), 7);
        assert_eq!((odd[1].x - odd[0].right(), odd[0].x, AREA.right() - odd[1].right()), (7, 7, 7));
        let tight = fit(Rect::new(-1920, 0, 1920, 1080), &fractions(Template::Columns, 3, false), 0);
        assert_eq!(tight[0].right(), tight[1].x);
        assert_eq!(tight[2].right(), 0, "a screen left of the main one");
    }

    #[test]
    fn finds_the_zone_under_the_pointer() {
        let zones = fit(AREA, &fractions(Template::Columns, 2, false), 20);
        assert_eq!(hit(&zones, 100, 300, 20), Some(0));
        assert_eq!(hit(&zones, 900, 300, 20), Some(1));
        assert_eq!(hit(&zones, 601, 300, 20), Some(1), "in the gap: the nearest");
        assert_eq!(hit(&zones, 600, -100, 20), None, "far from every zone");
        let focus = fit(AREA, &fractions(Template::Focus, 2, false), 0);
        assert_eq!(hit(&focus, 760, 380, 0), Some(1), "overlapping: the zone whose center is nearest");
    }

    #[test]
    fn spans_the_zones_between_two() {
        let zones = fit(AREA, &fractions(Template::Grid, 4, false), 0);
        assert_eq!(span(&zones, 0, 3), [0, 1, 2, 3]);
        assert_eq!(span(&zones, 1, 0), [0, 1]);
        assert_eq!(bounds(&zones, &[0, 1]), Some(Rect::new(0, 0, 1200, 300)));
        assert_eq!(bounds(&zones, &[]), None);
    }

    #[test]
    fn knows_which_zone_a_window_fills() {
        let zones = fit(AREA, &fractions(Template::Columns, 2, false), 0);
        assert_eq!(zone_of(&zones, &Rect::new(5, 0, 590, 600)), Some(0));
        assert_eq!(zone_of(&zones, &Rect::new(300, 0, 600, 600)), None, "across two zones");
        assert_eq!(zone_of(&zones, &Rect::new(0, 0, 100, 100)), None, "much smaller than its zone");
    }

    #[test]
    fn steps_through_zones_and_screens() {
        let one = fit(AREA, &fractions(Template::Columns, 2, false), 0);
        let two = fit(Rect::new(1200, 0, 800, 600), &fractions(Template::Columns, 2, false), 0);
        let screens = [one.clone(), two.clone()];
        let in_zone = |z: &Rect| *z;
        assert_eq!(step(&screens, 0, &in_zone(&one[0]), true, true), Some((0, 1)));
        assert_eq!(step(&screens, 0, &in_zone(&one[1]), true, true), Some((1, 0)), "on to the next screen");
        assert_eq!(step(&screens, 0, &in_zone(&one[1]), true, false), Some((0, 0)), "around the same screen");
        assert_eq!(step(&screens, 1, &in_zone(&two[0]), false, true), Some((0, 1)), "back to the previous screen");
        assert_eq!(step(&screens, 0, &Rect::new(10, 10, 50, 50), true, true), Some((0, 0)), "not in a zone: the first");
        assert_eq!(step(&screens, 0, &Rect::new(10, 10, 50, 50), false, true), Some((0, 1)), "or the last");
        assert_eq!(step(&[one], 0, &Rect::new(10, 10, 50, 50), true, true), Some((0, 0)));
        assert_eq!(step(&[], 0, &Rect::default(), true, true), None);
    }

    #[test]
    fn finds_screens_by_window_and_by_point() {
        let areas = [Rect::new(0, 0, 1200, 600), Rect::new(1200, 0, 800, 600)];
        assert_eq!(screen_of(&areas, &Rect::new(1100, 0, 400, 300)), 1, "mostly on the second");
        assert_eq!(screen_of(&areas, &Rect::new(-5000, 0, 10, 10)), 0, "on none: the first");
        assert_eq!(screen_at(&areas, 1500, 100), Some(1));
        assert_eq!(screen_at(&areas, 1500, 5000), Some(1), "below the screens: the nearest");
        assert_eq!(screen_at(&[], 0, 0), None);
    }
}
