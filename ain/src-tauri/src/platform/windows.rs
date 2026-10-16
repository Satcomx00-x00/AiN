//! Windows specifics shared by several backends.

/// COM and WinRT objects need an apartment on the thread that uses them.
pub fn init_com() {
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
    // SAFETY: called once at the start of a thread we own; the result only says whether it was already initialized.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
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
