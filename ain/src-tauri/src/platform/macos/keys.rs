//! Synthetic key presses. macOS only lets them through once the user allows the app under
//! System Settings → Privacy & Security → Accessibility; until then we ask (once per run), and the
//! caller falls back to the clipboard.

use std::{
    ffi::c_void,
    ptr,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
    static kAXTrustedCheckOptionPrompt: *const c_void;
}

/// Only their addresses are used.
#[repr(C)]
struct Opaque([u8; 0]);

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDictionaryCreate(
        allocator: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        count: isize,
        key_callbacks: *const Opaque,
        value_callbacks: *const Opaque,
    ) -> *const c_void;
    fn CFRelease(cf: *const c_void);
    static kCFBooleanTrue: *const c_void;
    static kCFTypeDictionaryKeyCallBacks: Opaque;
    static kCFTypeDictionaryValueCallBacks: Opaque;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceFlagsState(state: i32) -> u64;
    fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> *mut c_void;
    fn CGEventKeyboardSetUnicodeString(event: *mut c_void, length: usize, string: *const u16);
    fn CGEventSetFlags(event: *mut c_void, flags: u64);
    fn CGEventPost(tap: u32, event: *mut c_void);
}

/// `kCGEventSourceStateHIDSystemState`: the keys physically down.
const HID_STATE: i32 = 1;
/// `kCGHIDEventTap`: where hardware events enter the system.
const HID_TAP: u32 = 0;
const SHIFT: u64 = 1 << 17;
const CONTROL: u64 = 1 << 18;
const OPTION: u64 = 1 << 19;
const COMMAND: u64 = 1 << 20;
/// `kVK_ANSI_V`.
const KEY_V: u16 = 9;
/// `kVK_ANSI_C`.
const KEY_C: u16 = 8;
/// The most UTF-16 units one key event carries.
const PER_EVENT: usize = 20;
/// The shortcut's modifiers may still be down; typed characters would turn into shortcuts.
const MODIFIERS_GONE: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(15);
/// Apps drop keys sent back to back; a pause between events keeps them all.
const GAP: Duration = Duration::from_millis(2);

/// Set once macOS has shown its prompt this run.
static ASKED: AtomicBool = AtomicBool::new(false);

/// Whether we may send keys; the first time not, macOS shows its prompt pointing to the setting.
pub fn trusted() -> bool {
    if ASKED.swap(true, Ordering::SeqCst) {
        // SAFETY: no options: a plain query.
        return unsafe { AXIsProcessTrustedWithOptions(ptr::null()) } != 0;
    }
    // SAFETY: a one-entry dictionary of Core Foundation constants, released after the call.
    unsafe {
        let (key, value) = (kAXTrustedCheckOptionPrompt, kCFBooleanTrue);
        let options = CFDictionaryCreate(
            ptr::null(),
            &key,
            &value,
            1,
            &raw const kCFTypeDictionaryKeyCallBacks,
            &raw const kCFTypeDictionaryValueCallBacks,
        );
        let trusted = AXIsProcessTrustedWithOptions(options) != 0;
        if !options.is_null() {
            CFRelease(options);
        }
        trusted
    }
}

fn wait_for_modifiers() {
    let start = Instant::now();
    // SAFETY: a plain key-state query.
    while unsafe { CGEventSourceFlagsState(HID_STATE) } & (SHIFT | CONTROL | OPTION | COMMAND) != 0 && start.elapsed() < MODIFIERS_GONE {
        thread::sleep(POLL);
    }
}

/// Presses and releases `key` with `flags`, carrying `text` when there is some.
fn press(key: u16, flags: u64, text: &[u16]) {
    for down in [true, false] {
        // SAFETY: a keyboard event we create, fill, post and release; `text` outlives the call.
        unsafe {
            let event = CGEventCreateKeyboardEvent(ptr::null(), key, down);
            if event.is_null() {
                return;
            }
            if !text.is_empty() {
                CGEventKeyboardSetUnicodeString(event, text.len(), text.as_ptr());
            }
            CGEventSetFlags(event, flags);
            CGEventPost(HID_TAP, event);
            CFRelease(event);
        }
        thread::sleep(GAP);
    }
}

/// `text` in UTF-16 pieces of at most `max` units, never splitting a character.
pub fn pieces(text: &str, max: usize) -> Vec<Vec<u16>> {
    let mut out: Vec<Vec<u16>> = Vec::new();
    let mut buf = [0u16; 2];
    for c in text.chars() {
        let units = c.encode_utf16(&mut buf);
        match out.last_mut() {
            Some(last) if last.len() + units.len() <= max => last.extend_from_slice(units),
            _ => out.push(units.to_vec()),
        }
    }
    out
}

/// Types `text` where the cursor is, once the shortcut's keys are released; false when not allowed.
pub fn type_text(text: &str) -> bool {
    if !trusted() {
        return false;
    }
    wait_for_modifiers();
    for piece in pieces(text, PER_EVENT) {
        press(0, 0, &piece);
    }
    true
}

/// Presses Cmd+V; false when not allowed.
pub fn paste() -> bool {
    if !trusted() {
        return false;
    }
    wait_for_modifiers();
    press(KEY_V, COMMAND, &[]);
    true
}

/// Presses Cmd+C; false when not allowed.
pub fn copy() -> bool {
    if !trusted() {
        return false;
    }
    wait_for_modifiers();
    press(KEY_C, COMMAND, &[]);
    true
}

/// Changes with every new clipboard content.
pub fn clipboard_count() -> i64 {
    objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_text_without_breaking_characters() {
        assert_eq!(pieces("abc", 2), [vec![97, 98], vec![99]]);
        let emoji: Vec<u16> = "😀".encode_utf16().collect();
        assert_eq!(pieces("a😀", 2), [vec![97], emoji]);
        assert!(pieces("", 20).is_empty());
    }
}
