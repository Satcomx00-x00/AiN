//! Focus hand-off and a synthetic Cmd+V, so a picked item lands where the user was typing.
//! The previous app is remembered by process id.

use std::{thread, time::Duration};

use crate::platform::macos::{activate, frontmost, keys};

/// Time for the previous app to come back to the front before pasting into it.
const SETTLE: Duration = Duration::from_millis(120);

pub fn foreground() -> Option<isize> {
    frontmost().map(|pid| pid as isize)
}

pub fn paste_into(previous: Option<isize>) {
    if let Some(pid) = previous.and_then(|p| i32::try_from(p).ok()) {
        activate(pid);
    }
    thread::sleep(SETTLE);
    keys::paste();
}
