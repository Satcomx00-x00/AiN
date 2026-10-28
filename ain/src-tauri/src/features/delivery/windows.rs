//! Types text into whichever app has focus, as if from the keyboard.

use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY};

use crate::platform::windows::keys;

fn unit(code: u16, up: bool) -> INPUT {
    keys::input(VIRTUAL_KEY(0), code, if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE })
}

/// Waits for the modifier keys to be released, then sends `text` as Unicode key presses.
pub fn type_text(text: &str) {
    keys::wait_for_modifiers();
    let inputs: Vec<INPUT> = text.encode_utf16().flat_map(|c| [unit(c, false), unit(c, true)]).collect();
    // Some apps drop keys sent in one huge burst; small batches are safe.
    for batch in inputs.chunks(64) {
        keys::send(batch);
    }
}
