//! Zones, as PowerToys' FancyZones has them: a layout of zones on every screen, and windows
//! snapped into them by dragging them with Shift held (Ctrl spans several zones), from a zone
//! picker (a zone's number, or a click), or by a shortcut to the next or previous zone, on to the
//! next screen. Each OS reads the pointer and moves windows its own way (`windows.rs`,
//! `macos.rs`, `linux.rs`); where none can, zones report so and do nothing.
//!
//! One worker thread owns the OS backend: it follows the pointer while a window is dragged, runs
//! the shortcuts, and shows the `zones` overlay window, which only draws what it is sent.

mod drag;
mod layout;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as os;
#[cfg(target_os = "macos")]
use macos as os;
#[cfg(windows)]
use windows as os;

/// Elsewhere no window can be moved.
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod os {
    use super::{Desktop, Support};

    pub fn open() -> Option<Box<dyn Desktop>> {
        None
    }
    pub fn support() -> Support {
        Support { moves: false, drags: false, note: Some("Zones can't move windows on this system.".into()) }
    }
    pub fn allowed() -> bool {
        false
    }
    pub fn show_passive(window: &tauri::WebviewWindow, area: &super::Rect) -> tauri::Result<()> {
        super::cover(window, area)?;
        window.show()
    }
    pub fn hide_passive(window: &tauri::WebviewWindow) -> tauri::Result<()> {
        window.hide()
    }
}

use std::{sync::Arc, thread, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
    plugin::TauriPlugin,
};
use tauri_specta::Event;

use self::{
    drag::{Activation, Effect, Tracker},
    layout::{Frac, MAX_ZONES, Rect, Template},
};
use super::{
    live::Live,
    worker::{self, Worker},
};
use crate::{
    Res,
    shell::{
        popup::{self, ActionKind},
        settings::{self, SettingsChanged},
    },
};

pub const FEATURE: &str = "zones";
/// The overlay drawing the zones.
pub const WINDOW: &str = "zones";
/// While a window is pressed or dragged, the pointer is looked at this often…
const DRAGGING: Duration = Duration::from_millis(15);
/// …and otherwise this often, to see a press.
const WATCHING: Duration = Duration::from_millis(45);
/// With nothing to watch (dragging is off, or windows can't be moved here), the worker just
/// waits for the shortcuts.
const RESTING: Duration = Duration::from_secs(5);
/// The window manager ends its own move once the button is up; ours comes after it.
const SETTLE: Duration = Duration::from_millis(40);
/// How near a zone the pointer still picks it, in CSS pixels, when the spacing is smaller.
const REACH: f64 = 12.0;

/// Windows and X11 place windows in physical pixels; macOS in points.
const POINTS: bool = cfg!(target_os = "macos");

/// A window, as the OS backend names it: a window handle, an X11 window, or on macOS the
/// process whose focused window it is.
pub type Handle = isize;

/// Where the pointer is, in the desktop's coordinates, and what is held down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Pointer {
    pub x: i32,
    pub y: i32,
    /// The primary button.
    pub pressed: bool,
    pub shift: bool,
    pub ctrl: bool,
}

/// What zones need of the desktop.
pub trait Desktop {
    /// The pointer, or `None` when the system won't say.
    fn pointer(&mut self) -> Option<Pointer>;
    /// The window the user is in, unless it is ours or one that can't be moved (the desktop, a
    /// panel, a dialog that can't be resized).
    fn focused(&mut self) -> Option<Handle>;
    /// Its visible frame, without invisible borders or shadows.
    fn frame(&mut self, window: Handle) -> Option<Rect>;
    /// Moves and resizes it so its visible frame is `to`, out of maximized first.
    fn place(&mut self, window: Handle, to: Rect) -> Result<(), String>;
    /// Gives it the focus.
    fn activate(&mut self, window: Handle);
}

/// What zones can do on this system, for Settings to say.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    /// Whether windows can be moved at all.
    pub moves: bool,
    /// Whether dragging a window can show the zones.
    pub drags: bool,
    /// What to know or do first, e.g. a permission to give.
    pub note: Option<String>,
}

/// A zone as the overlay draws it: CSS pixels from the overlay's top left corner.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct Zone {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// What the overlay shows, sent on every change.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct OverlayChanged {
    pub zones: Vec<Zone>,
    /// The zones lit up: under the pointer, or spanned.
    pub lit: Vec<u32>,
    /// The zone picker: zones to click or to pick by number, rather than a drag's.
    pub picking: bool,
    /// Which screen of how many, when the picker can move between several.
    pub screen: u32,
    pub screens: u32,
}

/// The zones settings, read with the frontend's defaults.
#[derive(Debug, Clone, PartialEq)]
struct Config {
    template: Template,
    count: u32,
    /// Between zones and around them, in CSS pixels.
    spacing: u32,
    drag: Activation,
    /// Side-by-side layouts stack on portrait screens.
    rotate: bool,
    /// The next-zone shortcut goes on to the next screen.
    across: bool,
}

impl Config {
    fn read(settings: &Value) -> Self {
        let get = |key| settings::option(settings, FEATURE, key);
        let flag = |key, default| get(key).and_then(Value::as_bool).unwrap_or(default);
        Self {
            template: get("template").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or(Template::PriorityGrid),
            count: get("count").and_then(Value::as_u64).map_or(3, |n| n.clamp(1, MAX_ZONES.into()) as u32),
            spacing: get("spacing").and_then(Value::as_u64).map_or(16, |n| n.min(64) as u32),
            drag: match get("drag").and_then(Value::as_str) {
                Some("always") => Activation::Always,
                Some("off") => Activation::Off,
                _ => Activation::Shift,
            },
            rotate: flag("rotate", true),
            across: flag("across", true),
        }
    }
}

/// A monitor's zones, and where the overlay covers it.
#[derive(Debug, Clone, PartialEq)]
struct Screen {
    zones: drag::Zones,
    /// Desktop pixels per CSS pixel of the overlay.
    unit: f64,
    /// The work area in physical pixels, as our windows are placed.
    physical: Rect,
}

impl Screen {
    fn new(work: &PhysicalRect<i32, u32>, scale: f64, config: &Config) -> Self {
        let (to_desktop, unit) = if POINTS { (scale, 1.0) } else { (1.0, scale) };
        let at = |v: f64| (v / to_desktop).round() as i32;
        let area =
            Rect::new(at(work.position.x.into()), at(work.position.y.into()), at(work.size.width.into()), at(work.size.height.into()));
        let portrait = config.rotate && area.h > area.w;
        let spacing = (f64::from(config.spacing) * unit).round() as i32;
        let zones = layout::fit(area, &layout::fractions(config.template, config.count, portrait), spacing);
        let reach = spacing.max((REACH * unit).round() as i32);
        let physical = Rect::new(work.position.x, work.position.y, work.size.width as i32, work.size.height as i32);
        Self { zones: drag::Zones { area, zones, reach }, unit, physical }
    }

    /// Its zones as the overlay draws them.
    fn css(&self) -> Vec<Zone> {
        let area = self.zones.area;
        let css = |v: i32| f64::from(v) / self.unit;
        self.zones.zones.iter().map(|z| Zone { x: css(z.x - area.x), y: css(z.y - area.y), w: css(z.w), h: css(z.h) }).collect()
    }
}

/// Every monitor, left to right.
fn screens(app: &AppHandle, config: &Config) -> Vec<Screen> {
    let mut monitors = app.available_monitors().unwrap_or_default();
    monitors.sort_by_key(|m| (m.work_area().position.x, m.work_area().position.y));
    monitors.iter().map(|m| Screen::new(m.work_area(), m.scale_factor(), config)).collect()
}

enum Command {
    Configure(Config),
    /// To the next zone (`true`) or the previous one.
    Move(bool),
    Pick,
    Snap(usize),
    /// The picker moves this many screens on.
    Screen(i32),
    /// Closes the picker; `true` gives the focus back to the window it was for.
    Cancel(bool),
}

/// The zone picker under way: the window it moves, and the screen it shows.
struct Pick {
    window: Handle,
    screens: Vec<Screen>,
    screen: usize,
}

/// How the overlay is shown now: over which work area (physical pixels), and whether for the picker.
type Shown = (Rect, bool);

/// The worker's state, on its own thread.
struct Zones {
    app: AppHandle,
    desktop: Option<Box<dyn Desktop>>,
    config: Config,
    tracker: Tracker,
    /// The screens as they were when the drag under way started.
    dragged: Vec<Screen>,
    pick: Option<Pick>,
    shown: Option<Shown>,
    overlay: Arc<Live<OverlayChanged>>,
}

fn report(what: &str, result: Result<(), impl std::fmt::Display>) {
    if let Err(e) = result {
        eprintln!("island: zones: {what}: {e}");
    }
}

impl Zones {
    /// Runs a command, or looks at the pointer; returns how long until the next look.
    fn step(&mut self, command: Option<Command>) -> Duration {
        match command {
            None => self.look(),
            Some(Command::Configure(config)) => self.config = config,
            Some(Command::Move(forward)) => self.move_focused(forward),
            Some(Command::Pick) => self.open_picker(),
            Some(Command::Snap(zone)) => self.snap(zone),
            Some(Command::Screen(by)) => self.pick_screen(by),
            Some(Command::Cancel(refocus)) => self.close_picker(refocus),
        }
        if self.desktop.is_none() || self.config.drag == Activation::Off || self.pick.is_some() {
            RESTING
        } else if self.tracker.busy() {
            DRAGGING
        } else {
            WATCHING
        }
    }

    /// Follows the pointer, for a window being dragged.
    fn look(&mut self) {
        if self.pick.is_some() {
            return;
        }
        let Self { app, desktop, config, tracker, dragged, .. } = self;
        let Some(desktop) = desktop.as_deref_mut() else { return };
        let effects = tracker.step(desktop, config.drag, || {
            *dragged = screens(app, config);
            dragged.iter().map(|s| s.zones.clone()).collect()
        });
        for effect in effects {
            match effect {
                Effect::Show(lit) => {
                    if let Some(screen) = self.dragged.get(lit.screen).cloned() {
                        let lit = lit.lit.iter().map(|&i| i as u32).collect();
                        self.present(&screen, lit, false, (0, 0));
                    }
                }
                Effect::Hide => self.hide(),
                Effect::Snap { window, to } => {
                    thread::sleep(SETTLE);
                    if let Some(desktop) = self.desktop.as_deref_mut() {
                        report("snap", desktop.place(window, to));
                    }
                }
            }
        }
    }

    /// The window the user is in, with its frame, the screens and the one it is on.
    fn focused(&mut self) -> Option<(Handle, Rect, Vec<Screen>, usize)> {
        if !os::allowed() {
            return None;
        }
        let desktop = self.desktop.as_deref_mut()?;
        let window = desktop.focused()?;
        let frame = desktop.frame(window)?;
        let screens = screens(&self.app, &self.config);
        let areas: Vec<Rect> = screens.iter().map(|s| s.zones.area).collect();
        let on = layout::screen_of(&areas, &frame);
        Some((window, frame, screens, on))
    }

    fn move_focused(&mut self, forward: bool) {
        let Some((window, frame, screens, on)) = self.focused() else { return };
        let zones: Vec<Vec<Rect>> = screens.iter().map(|s| s.zones.zones.clone()).collect();
        let Some((s, z)) = layout::step(&zones, on, &frame, forward, self.config.across) else { return };
        if let Some(desktop) = self.desktop.as_deref_mut() {
            report("move", desktop.place(window, zones[s][z]));
        }
    }

    fn open_picker(&mut self) {
        if self.pick.is_some() {
            return self.pick_screen(1);
        }
        let Some((window, _, screens, screen)) = self.focused() else { return };
        self.pick = Some(Pick { window, screens, screen });
        self.show_picker();
    }

    fn show_picker(&mut self) {
        let Some(pick) = &self.pick else { return };
        let Some(screen) = pick.screens.get(pick.screen).cloned() else { return };
        let at = (pick.screen as u32, pick.screens.len() as u32);
        self.present(&screen, Vec::new(), true, at);
    }

    fn pick_screen(&mut self, by: i32) {
        if let Some(pick) = &mut self.pick {
            let count = pick.screens.len() as i32;
            pick.screen = (pick.screen as i32 + by).rem_euclid(count.max(1)) as usize;
        }
        self.show_picker();
    }

    fn snap(&mut self, zone: usize) {
        let Some(pick) = self.pick.take() else { return };
        self.hide();
        let Some(desktop) = self.desktop.as_deref_mut() else { return };
        if let Some(to) = pick.screens.get(pick.screen).and_then(|s| s.zones.zones.get(zone)) {
            report("snap", desktop.place(pick.window, *to));
        }
        desktop.activate(pick.window);
    }

    fn close_picker(&mut self, refocus: bool) {
        let Some(pick) = self.pick.take() else { return };
        self.hide();
        if let (true, Some(desktop)) = (refocus, self.desktop.as_deref_mut()) {
            desktop.activate(pick.window);
        }
    }

    /// Sends the overlay what to draw, then covers `screen` with it: passively for a drag (no
    /// focus, clicks go through), focused for the picker.
    fn present(&mut self, screen: &Screen, lit: Vec<u32>, picking: bool, (at, of): (u32, u32)) {
        // From a drag to the picker or back, the window changes how it takes focus and clicks.
        if self.shown.is_some_and(|(_, was)| was != picking) {
            self.hide();
        }
        let content = OverlayChanged { zones: screen.css(), lit, picking, screen: at, screens: of };
        if self.overlay.set(content.clone()) {
            report("draw", content.emit(&self.app));
        }
        let shown = (screen.physical, picking);
        if self.shown == Some(shown) {
            return;
        }
        let window = match overlay(&self.app) {
            Ok(window) => window,
            Err(e) => return report("overlay", Err::<(), _>(e)),
        };
        let result = (|| -> tauri::Result<()> {
            window.set_ignore_cursor_events(!picking)?;
            window.set_focusable(picking)?;
            if picking {
                cover(&window, &screen.physical)?;
                window.show()?;
                window.set_focus()
            } else {
                os::show_passive(&window, &screen.physical)
            }
        })();
        report("show", result);
        self.shown = Some(shown);
    }

    fn hide(&mut self) {
        let Some((_, picking)) = self.shown.take() else { return };
        let Some(window) = self.app.get_webview_window(WINDOW) else { return };
        report("hide", if picking { window.hide() } else { os::hide_passive(&window) });
        if self.overlay.set(OverlayChanged::default()) {
            report("draw", OverlayChanged::default().emit(&self.app));
        }
    }
}

/// Places a window over `area`, in physical pixels.
pub fn cover(window: &WebviewWindow, area: &Rect) -> tauri::Result<()> {
    window.set_position(PhysicalPosition::new(area.x, area.y))?;
    window.set_size(PhysicalSize::new(area.w.max(1) as u32, area.h.max(1) as u32))
}

/// The overlay window, made the first time.
fn overlay(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(WINDOW) {
        return Ok(window);
    }
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("zones.html".into()))
        .title("AiN zones")
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
        .build()
}

struct Shared {
    worker: Worker<Command>,
    overlay: Arc<Live<OverlayChanged>>,
}

impl Shared {
    fn send(&self, command: Command) -> Res<()> {
        self.worker.send(command)
    }
}

/// What zones can do here: Settings says it under the layout.
#[tauri::command]
#[specta::specta]
fn support() -> Support {
    os::support()
}

/// A layout's zones, as fractions of a screen, for Settings to draw.
#[tauri::command]
#[specta::specta]
fn layout(template: Template, count: u32, portrait: bool) -> Vec<Frac> {
    layout::fractions(template, count, portrait)
}

/// What the overlay shows now; it follows `OverlayChanged` after.
#[tauri::command]
#[specta::specta]
fn overlay_state(shared: State<'_, Shared>) -> OverlayChanged {
    shared.overlay.get()
}

/// The picker's choice: snaps the window to the zone at `zone` (from 0).
#[tauri::command]
#[specta::specta]
fn snap(shared: State<'_, Shared>, zone: u32) -> Res<()> {
    shared.send(Command::Snap(zone as usize))
}

/// Shows the picker on another screen, `by` screens on (negative: back).
#[tauri::command]
#[specta::specta]
fn screen(shared: State<'_, Shared>, by: i32) -> Res<()> {
    shared.send(Command::Screen(by))
}

/// Closes the picker without moving anything, giving the focus back to the window it was for
/// unless the user went to another (`refocus` false).
#[tauri::command]
#[specta::specta]
fn cancel(shared: State<'_, Shared>, refocus: bool) -> Res<()> {
    shared.send(Command::Cancel(refocus))
}

/// The command a shortcut press asks for, if it is one of ours.
fn command_for(action: &popup::Action) -> Option<Command> {
    if action.kind == ActionKind::Release {
        return None;
    }
    match action.command.strip_prefix("zones.")? {
        "next" => Some(Command::Move(true)),
        "previous" => Some(Command::Move(false)),
        "pick" => Some(Command::Pick),
        _ => None,
    }
}

crate::ipc::zones!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let overlay = Arc::new(Live::new(OverlayChanged::default()));
        let (handle, live) = (app.clone(), Arc::clone(&overlay));
        let config = Config::read(&settings::current(app));
        let worker = worker::spawn_paced(
            "zones",
            WATCHING,
            move || Zones {
                app: handle,
                desktop: os::open(),
                config,
                tracker: Tracker::default(),
                dragged: Vec::new(),
                pick: None,
                shown: None,
                overlay: live,
            },
            Zones::step,
        )?;
        app.manage(Shared { worker, overlay });
        let handle = app.clone();
        SettingsChanged::listen_any(app, move |event| {
            report("settings", handle.state::<Shared>().send(Command::Configure(Config::read(&event.payload.0.0))));
        });
        let handle = app.clone();
        popup::Action::listen_any(app, move |event| {
            if let Some(command) = command_for(&event.payload) {
                report("shortcut", handle.state::<Shared>().send(command));
            }
        });
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_settings_with_the_frontends_defaults() {
        let defaults = Config::read(&Value::Null);
        assert_eq!(
            defaults,
            Config { template: Template::PriorityGrid, count: 3, spacing: 16, drag: Activation::Shift, rotate: true, across: true }
        );
        let set = json!({ "options": { "zones": { "template": "grid", "count": 99, "spacing": 500, "drag": "off", "rotate": false } } });
        let config = Config::read(&set);
        assert_eq!(
            (config.template, config.count, config.spacing, config.drag, config.rotate),
            (Template::Grid, MAX_ZONES, 64, Activation::Off, false)
        );
        assert_eq!(Config::read(&json!({ "options": { "zones": { "template": "spiral" } } })).template, Template::PriorityGrid);
    }

    fn work(x: i32, y: i32, w: u32, h: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect { position: PhysicalPosition::new(x, y), size: PhysicalSize::new(w, h) }
    }

    #[test]
    fn fits_zones_to_a_screen_in_the_desktops_units() {
        let config = Config { template: Template::Columns, count: 2, spacing: 10, ..Config::read(&Value::Null) };
        let screen = Screen::new(&work(0, 0, 2000, 1000), 2.0, &config);
        let expected = if POINTS { Rect::new(0, 0, 1000, 500) } else { Rect::new(0, 0, 2000, 1000) };
        assert_eq!(screen.zones.area, expected, "points on macOS, physical pixels elsewhere");
        let css = screen.css();
        assert_eq!(css.iter().map(|z| (z.x, z.w)).collect::<Vec<_>>(), [(10.0, 485.0), (505.0, 485.0)], "the same in CSS pixels");
        let portrait = Screen::new(&work(0, 0, 1000, 2000), 1.0, &config);
        assert!(portrait.zones.zones[1].y > portrait.zones.zones[0].y, "columns stack on a portrait screen");
    }

    #[test]
    fn hears_only_its_own_shortcuts_when_pressed() {
        let action = |command: &str, kind| popup::Action { command: command.into(), kind };
        assert!(matches!(command_for(&action("zones.next", ActionKind::Press)), Some(Command::Move(true))));
        assert!(matches!(command_for(&action("zones.previous", ActionKind::Tap)), Some(Command::Move(false))));
        assert!(matches!(command_for(&action("zones.pick", ActionKind::Press)), Some(Command::Pick)));
        assert!(command_for(&action("zones.pick", ActionKind::Release)).is_none());
        assert!(command_for(&action("dictation.toggle", ActionKind::Press)).is_none());
    }
}
