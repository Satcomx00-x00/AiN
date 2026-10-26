//! Windows specifics shared by several backends.

/// A job object that ends every process put in it once the app ends, however it ends (closed,
/// crashed or killed): Windows closes the app's handle to it, the last one. Made on first use; none
/// if Windows refuses, and then helpers are left to end by themselves.
fn job() -> Option<windows::Win32::Foundation::HANDLE> {
    use std::sync::OnceLock;
    use windows::{
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::JobObjects::{
                CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JobObjectExtendedLimitInformation, SetInformationJobObject,
            },
        },
        core::PCWSTR,
    };
    // The handle as a number: a raw pointer isn't `Sync`. It is never closed while the app runs.
    static JOB: OnceLock<usize> = OnceLock::new();
    let raw = *JOB.get_or_init(|| {
        // SAFETY: plain Win32 calls on a handle this function owns; `info` outlives the call that reads it.
        unsafe {
            let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else { return 0 };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set.is_err() {
                let _ = CloseHandle(job);
                return 0;
            }
            job.0 as usize
        }
    });
    (raw != 0).then_some(HANDLE(raw as *mut std::ffi::c_void))
}

/// Puts a helper the app started in its job, so it ends with the app: uv or pip half-way through
/// an install, or PersonaPlex's server, would otherwise run on, holding their files.
pub fn end_with_app(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE, System::JobObjects::AssignProcessToJobObject};
    let Some(job) = job() else { return };
    // SAFETY: `child` owns a live process handle for the duration of the call.
    if let Err(e) = unsafe { AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())) } {
        eprintln!("island: a helper won't end with the app: {e}");
    }
}

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

    #[test]
    fn puts_a_helper_in_the_job_that_ends_with_the_app() {
        use std::os::windows::io::AsRawHandle;
        use windows::{
            Win32::{Foundation::HANDLE, System::JobObjects::IsProcessInJob},
            core::BOOL,
        };
        let mut child = std::process::Command::new("cmd").args(["/c", "ping -n 30 127.0.0.1 >nul"]).spawn().unwrap();
        end_with_app(&child);
        let mut inside = BOOL(0);
        // SAFETY: the child's handle is live until it is killed below.
        unsafe { IsProcessInJob(HANDLE(child.as_raw_handle()), job(), &mut inside) }.unwrap();
        let _ = child.kill();
        assert!(inside.as_bool(), "the helper is in the app's job");
    }
}
