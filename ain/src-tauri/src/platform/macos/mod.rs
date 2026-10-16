//! macOS specifics shared by several backends.

pub mod audio;
pub mod keys;

use std::ffi::{c_char, c_void};

use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};

/// The app the user is in, by process id, unless it's us.
pub fn frontmost() -> Option<i32> {
    let pid = NSWorkspace::sharedWorkspace().frontmostApplication()?.processIdentifier();
    (u32::try_from(pid).ok() != Some(std::process::id())).then_some(pid)
}

/// Whether an app with one of these bundle ids ("com.spotify.client") is running.
pub fn running(bundle_ids: &[&str]) -> bool {
    NSWorkspace::sharedWorkspace()
        .runningApplications()
        .iter()
        .any(|app| app.bundleIdentifier().is_some_and(|id| bundle_ids.contains(&id.to_string().as_str())))
}

/// Brings the app with process id `pid` to the front; false if it's gone.
pub fn activate(pid: i32) -> bool {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .is_some_and(|app| app.activateWithOptions(NSApplicationActivationOptions::empty()))
}

// Core Foundation, for the strings Core Audio hands out.
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
    fn CFStringGetLength(string: *const c_void) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(string: *const c_void, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
}

const UTF8: u32 = 0x0800_0100;

/// Reads a `CFStringRef` we own, then releases it.
///
/// # Safety
/// `string` must be a valid `CFStringRef` the caller owns (from a Create/Copy/Get-property call), or null.
pub unsafe fn take_string(string: *const c_void) -> Option<String> {
    if string.is_null() {
        return None;
    }
    // SAFETY: `string` is a valid CFString (caller's contract); the buffer is as large as we say.
    unsafe {
        let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(string), UTF8) + 1;
        let mut buffer = vec![0u8; usize::try_from(size).unwrap_or(0)];
        let ok = CFStringGetCString(string, buffer.as_mut_ptr().cast(), size, UTF8) != 0;
        CFRelease(string);
        let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
        ok.then(|| String::from_utf8_lossy(&buffer[..end]).into_owned())
    }
}
