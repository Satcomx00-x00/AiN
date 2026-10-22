//! Linux: windows are moved through the window manager, as the EWMH (freedesktop.org window
//! manager hints) asks: `_NET_ACTIVE_WINDOW` names the window the user is in, frame extents give
//! its visible frame (server-side decorations, or a GTK window's shadows), and
//! `_NET_MOVERESIZE_WINDOW` moves it. That is X11 only: Wayland lets no app move another's
//! windows, and there zones report so.

use x11rb::{
    connection::Connection,
    protocol::xproto::{AtomEnum, ClientMessageEvent, ConnectionExt, EventMask, KeyButMask, Window},
    rust_connection::RustConnection,
};

use super::{Desktop, Handle, Pointer, Rect, Support};

/// The atoms used, interned once.
struct Atoms {
    active: u32,
    pid: u32,
    frame: u32,
    gtk_frame: u32,
    state: u32,
    maximized_vert: u32,
    maximized_horz: u32,
    fullscreen: u32,
    moveresize: u32,
    kind: u32,
    desktop: u32,
    dock: u32,
}

pub struct X11 {
    conn: RustConnection,
    root: Window,
    atoms: Atoms,
}

/// `_NET_WM_STATE`'s "remove" action.
const REMOVE: u32 = 0;
/// As a pager or taskbar asks, which window managers honour over an app's own requests.
const FROM_PAGER: u32 = 2;
/// `_NET_MOVERESIZE_WINDOW`'s flags: static gravity (the client window's own corner), with x, y,
/// width and height all given, from a pager.
const MOVERESIZE: u32 = 10 | (0b1111 << 8) | (FROM_PAGER << 12);

fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|d| !d.is_empty())
}

pub fn open() -> Option<Box<dyn Desktop>> {
    if wayland() {
        return None;
    }
    let (conn, screen) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen)?.root;
    let intern = |name: &str| Some(conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok()?.atom);
    let atoms = Atoms {
        active: intern("_NET_ACTIVE_WINDOW")?,
        pid: intern("_NET_WM_PID")?,
        frame: intern("_NET_FRAME_EXTENTS")?,
        gtk_frame: intern("_GTK_FRAME_EXTENTS")?,
        state: intern("_NET_WM_STATE")?,
        maximized_vert: intern("_NET_WM_STATE_MAXIMIZED_VERT")?,
        maximized_horz: intern("_NET_WM_STATE_MAXIMIZED_HORZ")?,
        fullscreen: intern("_NET_WM_STATE_FULLSCREEN")?,
        moveresize: intern("_NET_MOVERESIZE_WINDOW")?,
        kind: intern("_NET_WM_WINDOW_TYPE")?,
        desktop: intern("_NET_WM_WINDOW_TYPE_DESKTOP")?,
        dock: intern("_NET_WM_WINDOW_TYPE_DOCK")?,
    };
    Some(Box::new(X11 { conn, root, atoms }))
}

pub fn support() -> Support {
    match (wayland(), x11rb::connect(None).is_ok()) {
        (true, _) => Support {
            moves: false,
            drags: false,
            note: Some("Wayland lets no app move other apps' windows: zones work in an X11 session.".into()),
        },
        (false, false) => Support { moves: false, drags: false, note: Some("Couldn't reach the X server.".into()) },
        (false, true) => Support { moves: true, drags: true, note: None },
    }
}

pub fn allowed() -> bool {
    true
}

pub fn show_passive(window: &tauri::WebviewWindow, area: &Rect) -> tauri::Result<()> {
    super::cover(window, area)?;
    window.show()
}

pub fn hide_passive(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.hide()
}

/// Left, right, top and bottom.
type Extents = [i32; 4];

/// A window's visible frame from its client area and its extents: the window manager's
/// decorations around it, a GTK window's shadows inside it.
fn visible(client: Rect, frame: Extents, gtk: Extents) -> Rect {
    let [l, r, t, b] = [frame[0] - gtk[0], frame[1] - gtk[1], frame[2] - gtk[2], frame[3] - gtk[3]];
    Rect::new(client.x - l, client.y - t, client.w + l + r, client.h + t + b)
}

/// The client area that gives a visible frame of `to`.
fn client_for(to: Rect, frame: Extents, gtk: Extents) -> Rect {
    let [l, r, t, b] = [frame[0] - gtk[0], frame[1] - gtk[1], frame[2] - gtk[2], frame[3] - gtk[3]];
    Rect::new(to.x + l, to.y + t, (to.w - l - r).max(1), (to.h - t - b).max(1))
}

impl X11 {
    fn cardinals(&self, window: Window, property: u32, kind: impl Into<u32>) -> Vec<u32> {
        let reply = self.conn.get_property(false, window, property, kind.into(), 0, 32).ok().and_then(|c| c.reply().ok());
        reply.and_then(|r| r.value32().map(Iterator::collect)).unwrap_or_default()
    }

    fn extents(&self, window: Window, property: u32) -> Extents {
        match self.cardinals(window, property, AtomEnum::CARDINAL)[..] {
            [l, r, t, b, ..] => [l, r, t, b].map(|v| v as i32),
            _ => [0; 4],
        }
    }

    fn states(&self, window: Window) -> Vec<u32> {
        self.cardinals(window, self.atoms.state, AtomEnum::ATOM)
    }

    fn message(&self, window: Window, kind: u32, data: [u32; 5]) -> Result<(), String> {
        let event = ClientMessageEvent::new(32, window, kind, data);
        let mask = EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY;
        self.conn.send_event(false, self.root, mask, event).map_err(|e| e.to_string())?;
        self.conn.flush().map_err(|e| e.to_string())
    }

    fn client(&self, window: Window) -> Option<Rect> {
        let geometry = self.conn.get_geometry(window).ok()?.reply().ok()?;
        let at = self.conn.translate_coordinates(window, self.root, 0, 0).ok()?.reply().ok()?;
        Some(Rect::new(at.dst_x.into(), at.dst_y.into(), geometry.width.into(), geometry.height.into()))
    }
}

impl Desktop for X11 {
    fn pointer(&mut self) -> Option<Pointer> {
        let reply = self.conn.query_pointer(self.root).ok()?.reply().ok()?;
        let held = |key: KeyButMask| u16::from(reply.mask) & u16::from(key) != 0;
        Some(Pointer {
            x: reply.root_x.into(),
            y: reply.root_y.into(),
            pressed: held(KeyButMask::BUTTON1),
            shift: held(KeyButMask::SHIFT),
            ctrl: held(KeyButMask::CONTROL),
        })
    }

    fn focused(&mut self) -> Option<Handle> {
        let window = *self.cardinals(self.root, self.atoms.active, AtomEnum::WINDOW).first().filter(|&&w| w != 0)?;
        let ours = self.cardinals(window, self.atoms.pid, AtomEnum::CARDINAL).first() == Some(&std::process::id());
        let kinds = self.cardinals(window, self.atoms.kind, AtomEnum::ATOM);
        let fixed = kinds.iter().any(|k| *k == self.atoms.desktop || *k == self.atoms.dock);
        let full = self.states(window).contains(&self.atoms.fullscreen);
        (!ours && !fixed && !full).then_some(window as Handle)
    }

    fn frame(&mut self, window: Handle) -> Option<Rect> {
        let window = window as Window;
        Some(visible(self.client(window)?, self.extents(window, self.atoms.frame), self.extents(window, self.atoms.gtk_frame)))
    }

    fn place(&mut self, window: Handle, to: Rect) -> Result<(), String> {
        let window = window as Window;
        let states = self.states(window);
        if states.contains(&self.atoms.maximized_vert) || states.contains(&self.atoms.maximized_horz) {
            let data = [REMOVE, self.atoms.maximized_vert, self.atoms.maximized_horz, FROM_PAGER, 0];
            self.message(window, self.atoms.state, data)?;
        }
        let client = client_for(to, self.extents(window, self.atoms.frame), self.extents(window, self.atoms.gtk_frame));
        let data = [MOVERESIZE, client.x as u32, client.y as u32, client.w as u32, client.h as u32];
        self.message(window, self.atoms.moveresize, data)
    }

    fn activate(&mut self, window: Handle) {
        // The current time isn't known here: 0, which window managers accept from a pager.
        let _ = self.message(window as Window, self.atoms.active, [FROM_PAGER, 0, 0, 0, 0]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_visible_frame_around_decorations_and_inside_shadows() {
        let client = Rect::new(100, 130, 800, 600);
        // A title bar of 30 and borders of 2, drawn by the window manager.
        assert_eq!(visible(client, [2, 2, 30, 2], [0; 4]), Rect::new(98, 100, 804, 632));
        // A GTK window drawing its own title bar, with 20 of shadow all around.
        assert_eq!(visible(client, [0; 4], [20; 4]), Rect::new(120, 150, 760, 560));
    }

    #[test]
    fn places_the_client_so_the_frame_lands_on_the_zone() {
        let zone = Rect::new(0, 0, 960, 1080);
        for (frame, gtk) in [([2, 2, 30, 2], [0; 4]), ([0; 4], [20; 4]), ([0; 4], [0; 4])] {
            assert_eq!(visible(client_for(zone, frame, gtk), frame, gtk), zone);
        }
    }
}
