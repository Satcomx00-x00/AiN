//! Windows specifics shared by several backends.

/// COM and WinRT objects need an apartment on the thread that uses them.
pub fn init_com() {
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
    // SAFETY: called once at the start of a thread we own; the result only says whether it was already initialized.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

/// Opens a link or a folder the way double-clicking it would. `explorer <link>` can't be trusted
/// with a long link full of `&` and `%` (a sign-in page's): it opens a folder instead.
pub fn shell_open(target: &std::ffi::OsStr) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        core::{PCWSTR, w},
    };
    init_com();
    let wide: Vec<u16> = target.encode_wide().chain([0]).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call; the other strings are null or static.
    let done = unsafe { ShellExecuteW(None, w!("open"), PCWSTR(wide.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    // It returns a value above 32 on success, an error code otherwise.
    if done.0 as usize > 32 { Ok(()) } else { Err(std::io::Error::other(format!("Windows couldn't open it (error {})", done.0 as usize))) }
}

/// "Spotify.exe" → "Spotify"; any folders in front are dropped too.
pub fn exe_stem(path: &str) -> &str {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    match file.len().checked_sub(4) {
        Some(cut) if file.is_char_boundary(cut) && file[cut..].eq_ignore_ascii_case(".exe") => &file[..cut],
        _ => file,
    }
}

/// Synthetic key presses into whichever app has focus.
pub mod keys {
    use std::{
        thread,
        time::{Duration, Instant},
    };

    use windows::Win32::{
        System::DataExchange::GetClipboardSequenceNumber,
        UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_C,
            VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
        },
    };

    /// The shortcut's modifiers may still be down; keys sent meanwhile would turn into other shortcuts.
    const MODIFIERS_GONE: Duration = Duration::from_secs(3);
    const POLL: Duration = Duration::from_millis(15);

    fn modifier_down() -> bool {
        [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
            // SAFETY: a plain key-state query.
            .iter()
            .any(|&vk| unsafe { GetAsyncKeyState(i32::from(vk.0)) } < 0)
    }

    /// Waits for the modifier keys to be released (for a few seconds at most).
    pub fn wait_for_modifiers() {
        let start = Instant::now();
        while modifier_down() && start.elapsed() < MODIFIERS_GONE {
            thread::sleep(POLL);
        }
    }

    pub fn input(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    /// Sends key events; false when the system blocked some (a higher-integrity window has focus).
    pub fn send(inputs: &[INPUT]) -> bool {
        // SAFETY: fully initialized keyboard events of the size we pass.
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        sent as usize == inputs.len()
    }

    /// Presses Ctrl+C once the shortcut's keys are released.
    pub fn copy() -> bool {
        wait_for_modifiers();
        let up = KEYEVENTF_KEYUP;
        let none = KEYBD_EVENT_FLAGS(0);
        send(&[input(VK_CONTROL, 0, none), input(VK_C, 0, none), input(VK_C, 0, up), input(VK_CONTROL, 0, up)])
    }

    /// Changes with every new clipboard content.
    pub fn clipboard_count() -> i64 {
        // SAFETY: a plain query.
        i64::from(unsafe { GetClipboardSequenceNumber() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_folders_and_exe() {
        assert_eq!(exe_stem(r"C:\Program Files\VideoLAN\VLC\vlc.EXE"), "vlc");
        assert_eq!(exe_stem("Spotify.exe"), "Spotify");
        assert_eq!(exe_stem("recorder"), "recorder");
    }
}
