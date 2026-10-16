//! Types text into whichever app has focus, as if from the keyboard.

use std::{
    thread,
    time::{Duration, Instant},
};

use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, SendInput, VIRTUAL_KEY, VK_CONTROL,
    VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};

/// The shortcut's modifiers may still be down; typed characters would turn into shortcuts.
const MODIFIERS_GONE: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(15);

fn modifier_down() -> bool {
    [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        // SAFETY: a plain key-state query.
        .iter()
        .any(|&vk| unsafe { GetAsyncKeyState(i32::from(vk.0)) } < 0)
}

fn unit(code: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: code,
                dwFlags: if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Waits for the modifier keys to be released, then sends `text` as Unicode key presses.
pub fn type_text(text: &str) {
    let start = Instant::now();
    while modifier_down() && start.elapsed() < MODIFIERS_GONE {
        thread::sleep(POLL);
    }
    let inputs: Vec<INPUT> = text.encode_utf16().flat_map(|c| [unit(c, false), unit(c, true)]).collect();
    // Some apps drop keys sent in one huge burst; small batches are safe.
    for batch in inputs.chunks(64) {
        // SAFETY: fully initialized keyboard events of the size we pass.
        unsafe {
            SendInput(batch, std::mem::size_of::<INPUT>() as i32);
        }
    }
}
