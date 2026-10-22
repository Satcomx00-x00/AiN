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

/// Opens a file or a folder with its default app, as double-clicking it would.
pub fn open_path(path: &std::path::Path) -> std::io::Result<()> {
    if !path.exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "it is no longer there"));
    }
    open(path.as_os_str())
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
    let mut command = std::process::Command::new(program);
    command.arg(target);
    detached(command)
}

/// Starts a program that should outlive the app (an app the user launched, a terminal): in its own
/// process group, without our standard streams, and reaped when it ends. On Linux it also leaves
/// behind what an AppImage puts in the environment for the app itself, which would break others.
#[cfg(not(windows))]
pub fn detached(mut command: std::process::Command) -> std::io::Result<()> {
    use std::{os::unix::process::CommandExt, process::Stdio};
    #[cfg(target_os = "linux")]
    linux::leave_appimage(&mut command);
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn()?;
    std::thread::Builder::new().name("reap".into()).spawn(move || drop(child.wait()))?;
    Ok(())
}

/// Whether `program` is a file on the `PATH` (or, given as a path, exists).
#[cfg(any(windows, target_os = "linux"))]
pub fn on_path(program: &str) -> bool {
    let program = std::path::Path::new(program);
    if program.components().count() > 1 {
        return program.is_file();
    }
    // Windows finds "pwsh" as pwsh.exe.
    let names: Vec<std::ffi::OsString> = match cfg!(windows) && program.extension().is_none() {
        true => ["exe", "cmd", "bat"].iter().map(|ext| program.with_extension(ext).into_os_string()).collect(),
        false => vec![program.as_os_str().to_owned()],
    };
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| names.iter().any(|name| dir.join(name).is_file())))
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
