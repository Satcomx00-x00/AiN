//! Helpers shared by several features' OS backends. Each feature keeps its own backend next to it
//! (`features/<name>/windows.rs`, `linux.rs`); only what they have in common lives here.

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(windows)]
pub mod windows;

/// Prepares a thread we spawned to own OS objects (on Windows, a COM apartment).
pub fn init_thread() {
    #[cfg(windows)]
    windows::init_com();
}

/// Shows `path` in the system's file manager.
pub fn reveal(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(windows, target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program).arg(path).spawn().map(drop)
}
