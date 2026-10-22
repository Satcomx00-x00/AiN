//! Snapping a window by dragging it: a state machine fed the pointer every few milliseconds.
//! A press on a window that then moves (and keeps its size) is a drag; while the zones are on
//! (Shift held, or always), the zone under the pointer lights up, Ctrl spans from where it was
//! pressed, and releasing the button snaps the window there.

use super::{
    Desktop, Handle, Pointer,
    layout::{self, Rect},
};

/// When dragging a window shows the zones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activation {
    /// While Shift is held.
    Shift,
    /// Always, unless Shift is held.
    Always,
    Off,
}

impl Activation {
    pub fn active(self, pointer: &Pointer) -> bool {
        match self {
            Self::Shift => pointer.shift,
            Self::Always => !pointer.shift,
            Self::Off => false,
        }
    }
}

/// A screen's zones, as dragging needs them.
#[derive(Debug, Clone, PartialEq)]
pub struct Zones {
    pub area: Rect,
    pub zones: Vec<Rect>,
    /// How far from a zone the pointer still picks it, in the spacing between zones.
    pub reach: i32,
}

/// What the overlay should show: a screen's zones, those at `lit` highlighted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lit {
    pub screen: usize,
    pub lit: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Show(Lit),
    Hide,
    Snap { window: Handle, to: Rect },
}

#[derive(Debug, Default)]
enum Phase {
    #[default]
    Idle,
    /// The button went down on `window`, whose frame was `start`.
    Pressed {
        window: Handle,
        start: Rect,
    },
    /// The window is being resized, or the press wasn't on a window we move: wait for the release.
    Ignored,
    Dragging {
        window: Handle,
        screens: Vec<Zones>,
        shown: Option<Lit>,
        anchor: Option<(usize, usize)>,
    },
}

#[derive(Debug, Default)]
pub struct Tracker {
    phase: Phase,
}

impl Tracker {
    /// Whether a drag is under way (the pointer is then looked at more often).
    pub fn busy(&self) -> bool {
        !matches!(self.phase, Phase::Idle)
    }

    /// One look at the pointer. `screens` lays out the zones of every screen; it is asked once,
    /// when a drag starts.
    pub fn step(&mut self, desktop: &mut dyn Desktop, activation: Activation, screens: impl FnOnce() -> Vec<Zones>) -> Vec<Effect> {
        let Some(pointer) = desktop.pointer() else {
            return self.reset();
        };
        match std::mem::take(&mut self.phase) {
            Phase::Idle => {
                if pointer.pressed && activation != Activation::Off {
                    self.phase = match desktop.focused().and_then(|w| Some((w, desktop.frame(w)?))) {
                        Some((window, start)) => Phase::Pressed { window, start },
                        None => Phase::Ignored,
                    };
                }
                Vec::new()
            }
            Phase::Ignored => {
                if pointer.pressed {
                    self.phase = Phase::Ignored;
                }
                Vec::new()
            }
            Phase::Pressed { window, start } => {
                if !pointer.pressed {
                    return Vec::new();
                }
                // A press activates the window under it, which the first look may have missed.
                let focused = desktop.focused();
                self.phase = match (focused, focused.and_then(|w| desktop.frame(w))) {
                    (Some(w), Some(frame)) if w != window => Phase::Pressed { window: w, start: frame },
                    (Some(_), Some(frame)) if (frame.w, frame.h) != (start.w, start.h) => Phase::Ignored,
                    (Some(_), Some(frame)) if (frame.x, frame.y) != (start.x, start.y) => {
                        Phase::Dragging { window, screens: screens(), shown: None, anchor: None }
                    }
                    (Some(_), Some(_)) => Phase::Pressed { window, start },
                    _ => Phase::Ignored,
                };
                Vec::new()
            }
            Phase::Dragging { window, screens, shown, anchor } => self.drag(&pointer, activation, window, screens, shown, anchor),
        }
    }

    fn drag(
        &mut self,
        pointer: &Pointer,
        activation: Activation,
        window: Handle,
        screens: Vec<Zones>,
        shown: Option<Lit>,
        anchor: Option<(usize, usize)>,
    ) -> Vec<Effect> {
        if !pointer.pressed {
            let Some(lit) = shown else { return Vec::new() };
            let to = screens.get(lit.screen).and_then(|s| layout::bounds(&s.zones, &lit.lit));
            return [Some(Effect::Hide), to.map(|to| Effect::Snap { window, to })].into_iter().flatten().collect();
        }
        if !activation.active(pointer) {
            self.phase = Phase::Dragging { window, screens, shown: None, anchor: None };
            return if shown.is_some() { vec![Effect::Hide] } else { Vec::new() };
        }
        let areas: Vec<Rect> = screens.iter().map(|s| s.area).collect();
        let Some(screen) = layout::screen_at(&areas, pointer.x, pointer.y) else {
            self.phase = Phase::Dragging { window, screens, shown, anchor };
            return Vec::new();
        };
        let zones = &screens[screen];
        let under = layout::hit(&zones.zones, pointer.x, pointer.y, zones.reach);
        // Ctrl spans from the zone it went down over, on the same screen.
        let anchor = match (pointer.ctrl, anchor, under) {
            (false, ..) => None,
            (true, Some((s, a)), _) if s == screen => Some((s, a)),
            (true, _, Some(u)) => Some((screen, u)),
            (true, ..) => None,
        };
        let lit = match (anchor, under) {
            (Some((_, a)), Some(u)) => layout::span(&zones.zones, a, u),
            (_, Some(u)) => vec![u],
            _ => Vec::new(),
        };
        let next = Lit { screen, lit };
        let effects = if shown.as_ref() == Some(&next) { Vec::new() } else { vec![Effect::Show(next.clone())] };
        self.phase = Phase::Dragging { window, screens, shown: Some(next), anchor };
        effects
    }

    /// Back to waiting for a press, hiding the zones if they were shown.
    fn reset(&mut self) -> Vec<Effect> {
        match std::mem::take(&mut self.phase) {
            Phase::Dragging { shown: Some(_), .. } => vec![Effect::Hide],
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A desktop with one window, moved by hand between steps.
    struct Fake {
        pointer: Option<Pointer>,
        frame: Rect,
    }

    impl Desktop for Fake {
        fn pointer(&mut self) -> Option<Pointer> {
            self.pointer
        }
        fn focused(&mut self) -> Option<Handle> {
            Some(7)
        }
        fn frame(&mut self, _: Handle) -> Option<Rect> {
            Some(self.frame)
        }
        fn place(&mut self, _: Handle, to: Rect) -> Result<(), String> {
            self.frame = to;
            Ok(())
        }
        fn activate(&mut self, _: Handle) {}
    }

    fn screens() -> Vec<Zones> {
        let left = Rect::new(0, 0, 1000, 500);
        let right = Rect::new(1000, 0, 1000, 500);
        let halves = |a: Rect| vec![Rect::new(a.x, 0, 500, 500), Rect::new(a.x + 500, 0, 500, 500)];
        vec![Zones { area: left, zones: halves(left), reach: 10 }, Zones { area: right, zones: halves(right), reach: 10 }]
    }

    fn at(x: i32, y: i32) -> Pointer {
        Pointer { x, y, pressed: true, shift: true, ctrl: false }
    }

    /// Presses on the window, then drags it a little: the tracker is then dragging.
    fn dragging(tracker: &mut Tracker, desktop: &mut Fake, activation: Activation) {
        desktop.pointer = Some(at(100, 100));
        assert!(tracker.step(desktop, activation, screens).is_empty());
        desktop.frame.x += 20;
        assert!(tracker.step(desktop, activation, screens).is_empty());
        assert!(tracker.busy());
    }

    fn fake() -> Fake {
        Fake { pointer: None, frame: Rect::new(50, 50, 300, 200) }
    }

    #[test]
    fn lights_the_zone_under_the_pointer_and_snaps_on_release() {
        let (mut tracker, mut desktop) = (Tracker::default(), fake());
        dragging(&mut tracker, &mut desktop, Activation::Shift);
        desktop.pointer = Some(at(700, 200));
        assert_eq!(tracker.step(&mut desktop, Activation::Shift, screens), [Effect::Show(Lit { screen: 0, lit: vec![1] })]);
        assert!(tracker.step(&mut desktop, Activation::Shift, screens).is_empty(), "nothing new to show");
        desktop.pointer = Some(at(1700, 200));
        assert_eq!(tracker.step(&mut desktop, Activation::Shift, screens), [Effect::Show(Lit { screen: 1, lit: vec![1] })]);
        desktop.pointer = Some(Pointer { pressed: false, ..at(1700, 200) });
        assert_eq!(
            tracker.step(&mut desktop, Activation::Shift, screens),
            [Effect::Hide, Effect::Snap { window: 7, to: Rect::new(1500, 0, 500, 500) }]
        );
        assert!(!tracker.busy());
    }

    #[test]
    fn shows_zones_only_while_shift_is_held_or_unless_it_is() {
        let (mut tracker, mut desktop) = (Tracker::default(), fake());
        dragging(&mut tracker, &mut desktop, Activation::Shift);
        desktop.pointer = Some(Pointer { shift: false, ..at(200, 200) });
        assert!(tracker.step(&mut desktop, Activation::Shift, screens).is_empty());
        desktop.pointer = Some(at(200, 200));
        assert_eq!(tracker.step(&mut desktop, Activation::Shift, screens).len(), 1);
        desktop.pointer = Some(Pointer { shift: false, ..at(200, 200) });
        assert_eq!(tracker.step(&mut desktop, Activation::Shift, screens), [Effect::Hide]);
        desktop.pointer = Some(Pointer { pressed: false, shift: false, ..at(200, 200) });
        assert!(tracker.step(&mut desktop, Activation::Shift, screens).is_empty(), "released with no zone shown: no snap");

        let (mut tracker, mut desktop) = (Tracker::default(), fake());
        dragging(&mut tracker, &mut desktop, Activation::Always);
        desktop.pointer = Some(Pointer { shift: false, ..at(200, 200) });
        assert_eq!(tracker.step(&mut desktop, Activation::Always, screens), [Effect::Show(Lit { screen: 0, lit: vec![0] })]);
    }

    #[test]
    fn spans_zones_with_ctrl() {
        let (mut tracker, mut desktop) = (Tracker::default(), fake());
        dragging(&mut tracker, &mut desktop, Activation::Shift);
        desktop.pointer = Some(Pointer { ctrl: true, ..at(200, 200) });
        tracker.step(&mut desktop, Activation::Shift, screens);
        desktop.pointer = Some(Pointer { ctrl: true, ..at(800, 200) });
        assert_eq!(tracker.step(&mut desktop, Activation::Shift, screens), [Effect::Show(Lit { screen: 0, lit: vec![0, 1] })]);
        desktop.pointer = Some(Pointer { ctrl: true, pressed: false, ..at(800, 200) });
        assert_eq!(tracker.step(&mut desktop, Activation::Shift, screens)[1], Effect::Snap { window: 7, to: Rect::new(0, 0, 1000, 500) });
    }

    #[test]
    fn ignores_resizing_clicks_and_dragging_when_off() {
        let (mut tracker, mut desktop) = (Tracker::default(), fake());
        desktop.pointer = Some(at(100, 100));
        tracker.step(&mut desktop, Activation::Shift, screens);
        desktop.frame.w += 40;
        tracker.step(&mut desktop, Activation::Shift, screens);
        desktop.frame.x += 40;
        desktop.pointer = Some(at(700, 200));
        assert!(tracker.step(&mut desktop, Activation::Shift, screens).is_empty(), "a resize is never a drag");
        desktop.pointer = Some(Pointer { pressed: false, ..at(700, 200) });
        assert!(tracker.step(&mut desktop, Activation::Shift, screens).is_empty());
        assert!(!tracker.busy());

        desktop.pointer = Some(at(100, 100));
        let calls = std::cell::Cell::new(0);
        tracker.step(&mut desktop, Activation::Off, || {
            calls.set(1);
            screens()
        });
        assert!(!tracker.busy() && calls.get() == 0, "off: presses aren't even looked at");
    }

    #[test]
    fn hides_the_zones_when_the_pointer_cant_be_read() {
        let (mut tracker, mut desktop) = (Tracker::default(), fake());
        dragging(&mut tracker, &mut desktop, Activation::Shift);
        desktop.pointer = Some(at(200, 200));
        tracker.step(&mut desktop, Activation::Shift, screens);
        desktop.pointer = None;
        assert_eq!(tracker.step(&mut desktop, Activation::Shift, screens), [Effect::Hide]);
        assert!(!tracker.busy());
    }
}
