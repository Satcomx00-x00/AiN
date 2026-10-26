//! Helpers shared by several features' OS backends. Each feature keeps its own backend next to it
//! (`features/<name>/windows.rs`, `linux.rs`, `macos.rs`); only what they have in common lives here.

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(windows)]
pub mod windows;

/// Prepares a thread we spawned to own OS objects (on Windows, a COM apartment).
pub fn init_thread() {
    #[cfg(windows)]
    windows::init_com();
}

/// Shows `path` in the system's file manager.
pub fn reveal(path: &std::path::Path) -> std::io::Result<()> {
    open(path.as_os_str())
}

/// Opens an https link in the default browser.
pub fn open_url(url: &str) -> std::io::Result<()> {
    if !url.starts_with("https://") {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not an https link"));
    }
    open(url.as_ref())
}

/// Ties a helper program we start to the app: on Linux it ends with the app, even when the app is
/// killed; on Windows it opens no console window.
#[cfg_attr(target_os = "macos", allow(unused_variables, reason = "nothing to tie on macOS"))]
pub fn tie_to_app(command: &mut std::process::Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: prctl only changes the child's own death signal, between fork and exec, and is
        // async-signal-safe.
        unsafe {
            command.pre_exec(|| match libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) {
                0 => Ok(()),
                _ => Err(std::io::Error::last_os_error()),
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(windows)]
fn open(target: &std::ffi::OsStr) -> std::io::Result<()> {
    windows::shell_open(target)
}

#[cfg(not(windows))]
fn open(target: &std::ffi::OsStr) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(target_os = "macos"))]
    let program = "xdg-open";
    std::process::Command::new(program).arg(target).spawn().map(drop)
}

#[cfg(test)]
mod tests {
    #[test]
    fn opens_only_https_links() {
        for url in ["http://github.com/o/r", "file:///etc/passwd", r"C:\Windows\System32\calc.exe", "javascript:alert(1)"] {
            assert_eq!(super::open_url(url).unwrap_err().kind(), std::io::ErrorKind::InvalidInput, "{url}");
        }
    }
}
