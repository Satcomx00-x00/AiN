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
