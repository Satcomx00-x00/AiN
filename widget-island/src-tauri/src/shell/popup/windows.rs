//! Focus hand-off and a synthetic Ctrl+V, so a picked item lands where the user was typing.

use std::{thread, time::Duration};

use windows::Win32::{
    Foundation::HWND,
    UI::{
        Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_CONTROL, VK_V,
        },
        WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow},
    },
};

/// Time for focus to move back before typing into it.
const SETTLE: Duration = Duration::from_millis(80);

pub fn foreground() -> Option<isize> {
    // SAFETY: a plain query with no arguments.
    let hwnd = unsafe { GetForegroundWindow() };
    (!hwnd.is_invalid()).then_some(hwnd.0 as isize)
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 },
        },
    }
}

pub fn paste_into(previous: Option<isize>) {
    if let Some(h) = previous {
        // SAFETY: `h` came from GetForegroundWindow; if that window is gone the call just fails.
        unsafe {
            let _ = SetForegroundWindow(HWND(h as *mut _));
        }
    }
    thread::sleep(SETTLE);
    let inputs = [key(VK_CONTROL, false), key(VK_V, false), key(VK_V, true), key(VK_CONTROL, true)];
    // SAFETY: the inputs are fully initialized keyboard events of the size we pass.
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}
