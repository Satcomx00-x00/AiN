//! macOS: windows are moved through the Accessibility API, which needs the user's leave (System
//! Settings → Privacy & Security → Accessibility). The window the user is in is the frontmost
//! app's focused window, so a window is known by its app's process id. The pointer, its button
//! and the modifiers come from Core Graphics, in the same points (from the top left of the main
//! screen) as window positions.

use std::{
    ffi::c_void,
    ptr::{self, NonNull},
};

use super::{Desktop, Handle, Pointer, Rect, Support};
use crate::platform::macos::{activate, frontmost, keys};

type Ref = *const c_void;

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> Ref;
    fn AXUIElementCopyAttributeValue(element: Ref, attribute: Ref, value: *mut Ref) -> i32;
    fn AXUIElementSetAttributeValue(element: Ref, attribute: Ref, value: Ref) -> i32;
    fn AXValueCreate(kind: u32, value: *const c_void) -> Ref;
    fn AXValueGetValue(value: Ref, kind: u32, out: *mut c_void) -> u8;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithBytes(allocator: Ref, bytes: *const u8, length: isize, encoding: u32, external: u8) -> Ref;
    fn CFBooleanGetValue(boolean: Ref) -> u8;
    fn CFRelease(cf: Ref);
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreate(source: Ref) -> Ref;
    fn CGEventGetLocation(event: Ref) -> CGPoint;
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    fn CGEventSourceFlagsState(state: i32) -> u64;
}

const UTF8: u32 = 0x0800_0100;
const AX_POINT: u32 = 1;
const AX_SIZE: u32 = 2;
/// `kCGEventSourceStateCombinedSessionState` and `kCGEventSourceStateHIDSystemState`.
const SESSION: i32 = 0;
const HID: i32 = 1;
const LEFT_BUTTON: u32 = 0;
const SHIFT: u64 = 1 << 17;
const CONTROL: u64 = 1 << 18;

/// A Core Foundation object we own, released when dropped.
struct Owned(NonNull<c_void>);

impl Owned {
    /// # Safety
    /// `object` must be null or a Core Foundation object the caller owns (from a Create or Copy call).
    unsafe fn new(object: Ref) -> Option<Self> {
        NonNull::new(object.cast_mut()).map(Self)
    }

    fn get(&self) -> Ref {
        self.0.as_ptr()
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: we own this reference (see `new`).
        unsafe { CFRelease(self.get()) }
    }
}

/// The attribute names used, made once.
pub struct Ax {
    focused_window: Owned,
    position: Owned,
    size: Owned,
    full_screen: Owned,
}

fn name(text: &str) -> Option<Owned> {
    // SAFETY: the bytes outlive the call, which copies them; the string returned is ours.
    unsafe { Owned::new(CFStringCreateWithBytes(ptr::null(), text.as_ptr(), text.len() as isize, UTF8, 0)) }
}

pub fn open() -> Option<Box<dyn Desktop>> {
    let ax = Ax {
        focused_window: name("AXFocusedWindow")?,
        position: name("AXPosition")?,
        size: name("AXSize")?,
        full_screen: name("AXFullScreen")?,
    };
    Some(Box::new(ax))
}

pub fn support() -> Support {
    let note =
        (!keys::allowed()).then(|| "Allow AiN under System Settings → Privacy & Security → Accessibility to move windows.".to_string());
    Support { moves: true, drags: true, note, install: false }
}

/// Asks for Accessibility access the first time it's missing (macOS shows its own prompt).
pub fn install_helper() -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

pub fn allowed() -> bool {
    keys::trusted()
}

pub fn show_passive(window: &tauri::WebviewWindow, area: &Rect) -> tauri::Result<()> {
    super::cover(window, area)?;
    window.show()
}

pub fn hide_passive(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.hide()
}

impl Ax {
    /// An attribute's value, ours to release.
    fn copy(&self, element: Ref, attribute: &Owned) -> Option<Owned> {
        let mut value: Ref = ptr::null();
        // SAFETY: a live element and attribute name; on success the value is a new reference.
        let error = unsafe { AXUIElementCopyAttributeValue(element, attribute.get(), &mut value) };
        // SAFETY: on success `value` is ours; otherwise null.
        if error == 0 { unsafe { Owned::new(value) } } else { None }
    }

    /// The focused window of the app with process id `pid`.
    fn window(&self, pid: Handle) -> Option<Owned> {
        let pid = i32::try_from(pid).ok()?;
        // SAFETY: a new reference to the app's accessibility element.
        let app = unsafe { Owned::new(AXUIElementCreateApplication(pid)) }?;
        self.copy(app.get(), &self.focused_window)
    }

    fn read<T: Default>(&self, window: &Owned, attribute: &Owned, kind: u32) -> Option<T> {
        let value = self.copy(window.get(), attribute)?;
        let mut out = T::default();
        // SAFETY: `out` is the type `kind` names (a CGPoint or a CGSize).
        let ok = unsafe { AXValueGetValue(value.get(), kind, (&raw mut out).cast()) } != 0;
        ok.then_some(out)
    }

    fn write<T>(&self, window: &Owned, attribute: &Owned, kind: u32, value: &T) -> Result<(), String> {
        // SAFETY: `value` is the type `kind` names; the AXValue made from it is ours.
        let value = unsafe { Owned::new(AXValueCreate(kind, (value as *const T).cast())) }.ok_or("out of memory")?;
        // SAFETY: a live window element, attribute name and value.
        match unsafe { AXUIElementSetAttributeValue(window.get(), attribute.get(), value.get()) } {
            0 => Ok(()),
            -25205 => Err("allow AiN under Privacy & Security → Accessibility".into()),
            error => Err(format!("the app refused (error {error})")),
        }
    }
}

impl Desktop for Ax {
    fn pointer(&mut self) -> Option<Pointer> {
        // SAFETY: a new event, only read, then released.
        let at = unsafe {
            let event = Owned::new(CGEventCreate(ptr::null()))?;
            CGEventGetLocation(event.get())
        };
        // SAFETY: plain state queries.
        let (pressed, flags) = unsafe { (CGEventSourceButtonState(SESSION, LEFT_BUTTON), CGEventSourceFlagsState(HID)) };
        Some(Pointer { x: at.x.round() as i32, y: at.y.round() as i32, pressed, shift: flags & SHIFT != 0, ctrl: flags & CONTROL != 0 })
    }

    fn focused(&mut self) -> Option<Handle> {
        // Without Accessibility access no window can be read: nothing to drag.
        keys::allowed().then(frontmost).flatten().map(|pid| pid as Handle)
    }

    fn frame(&mut self, window: Handle) -> Option<Rect> {
        let window = self.window(window)?;
        let at: CGPoint = self.read(&window, &self.position, AX_POINT)?;
        let size: CGSize = self.read(&window, &self.size, AX_SIZE)?;
        Some(Rect::new(at.x.round() as i32, at.y.round() as i32, size.width.round() as i32, size.height.round() as i32))
    }

    fn place(&mut self, window: Handle, to: Rect) -> Result<(), String> {
        let window = self.window(window).ok_or("no window to move")?;
        // SAFETY: an attribute's value, a CFBoolean when set, read then released.
        let full = self.copy(window.get(), &self.full_screen).is_some_and(|v| unsafe { CFBooleanGetValue(v.get()) } != 0);
        if full {
            return Err("it is full screen".into());
        }
        let (at, size) = (CGPoint { x: to.x.into(), y: to.y.into() }, CGSize { width: to.w.into(), height: to.h.into() });
        // Sized first, so it fits where it goes; moved; sized again, since a screen's edge may
        // have kept it smaller.
        self.write(&window, &self.size, AX_SIZE, &size)?;
        self.write(&window, &self.position, AX_POINT, &at)?;
        self.write(&window, &self.size, AX_SIZE, &size)
    }

    fn activate(&mut self, window: Handle) {
        if let Ok(pid) = i32::try_from(window) {
            activate(pid);
        }
    }
}
