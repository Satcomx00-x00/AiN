//! Focus hand-off and a synthetic Ctrl+V, so a picked item lands where the user was typing.
//! On X11 the previous window is remembered and focused again; Wayland gives focus back by itself
//! when the popup hides.

use std::{thread, time::Duration};

use crate::platform::linux::keys;

/// Time for focus to move back before pasting.
const SETTLE: Duration = Duration::from_millis(80);

pub fn foreground() -> Option<isize> {
    keys::active_window()
}

pub fn paste_into(previous: Option<isize>) {
    thread::sleep(SETTLE);
    keys::paste(previous);
}
