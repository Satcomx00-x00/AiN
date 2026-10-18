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
