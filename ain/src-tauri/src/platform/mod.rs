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

/// Ties a helper program we start to the app: on Linux it ends with the app, even when the app is
/// killed; on Windows it opens no console window.
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

/// Makes a helper the app started end with it, however the app ends. On Linux `tie_to_app` already
/// did, before it started.
#[cfg_attr(not(windows), allow(unused_variables, reason = "only Windows needs the started process"))]
pub fn end_with_app(child: &std::process::Child) {
    #[cfg(windows)]
    windows::end_with_app(child);
}

#[cfg(windows)]
fn open(target: &std::ffi::OsStr) -> std::io::Result<()> {
    windows::shell_open(target)
}

#[cfg(not(windows))]
fn open(target: &std::ffi::OsStr) -> std::io::Result<()> {
    let mut command = std::process::Command::new("xdg-open");
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
