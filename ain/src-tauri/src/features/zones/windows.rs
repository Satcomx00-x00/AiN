//! Windows: the window the user is in is the foreground one; its visible frame comes from the
//! desktop window manager (without the invisible resize borders), and `SetWindowPos` moves it,
//! twice when the move takes it to a screen of another scale and the app resizes itself.

use std::{ffi::c_void, mem::size_of};

use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
    UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY, VK_CONTROL, VK_LBUTTON, VK_RBUTTON, VK_SHIFT},
        WindowsAndMessaging::{
            GWL_STYLE, GetClassNameW, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowLongW, GetWindowRect,
            GetWindowThreadProcessId, HWND_TOPMOST, IsIconic, IsWindowVisible, IsZoomed, SM_SWAPBUTTON, SW_HIDE, SW_RESTORE,
            SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER, SWP_SHOWWINDOW, SetForegroundWindow, SetWindowPos,
            ShowWindow, ShowWindowAsync, WS_CHILD, WS_THICKFRAME,
        },
    },
};

use super::{Desktop, Handle, Pointer, Rect, Support};

/// The shell's own windows: the desktop and the taskbars.
const SHELL: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

pub struct Win;

pub fn open() -> Option<Box<dyn Desktop>> {
    Some(Box::new(Win))
}

pub fn support() -> Support {
    Support { moves: true, drags: true, note: None }
}

pub fn allowed() -> bool {
    true
}

const fn hwnd(window: Handle) -> HWND {
    HWND(window as *mut c_void)
}

/// Covers `area` without taking the focus from the window being dragged: `show()` would.
pub fn show_passive(window: &tauri::WebviewWindow, area: &Rect) -> tauri::Result<()> {
    let overlay = HWND(window.hwnd()?.0);
    // SAFETY: our own top-level window, positioned asynchronously since another thread owns it.
    let shown = unsafe {
        SetWindowPos(overlay, Some(HWND_TOPMOST), area.x, area.y, area.w, area.h, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS)
    };
    shown.map_err(|e| tauri::Error::Io(std::io::Error::other(e)))
}

pub fn hide_passive(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let overlay = HWND(window.hwnd()?.0);
    // SAFETY: our own window; hidden asynchronously since another thread owns it.
    unsafe {
        let _ = ShowWindowAsync(overlay, SW_HIDE);
    }
    Ok(())
}

fn down(key: VIRTUAL_KEY) -> bool {
    // SAFETY: a plain key-state query; the top bit says the key is down now.
    (unsafe { GetAsyncKeyState(key.0.into()) } as u16) & 0x8000 != 0
}

fn rect(r: RECT) -> Rect {
    Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top)
}

fn class(window: HWND) -> String {
    let mut name = [0u16; 64];
    // SAFETY: the buffer outlives the call, which writes at most its length.
    let len = unsafe { GetClassNameW(window, &mut name) };
    String::from_utf16_lossy(&name[..len.max(0) as usize])
}

/// Its outer rectangle, invisible borders included.
fn outer(window: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    // SAFETY: `r` is valid for the call; a window that's gone just fails.
    unsafe { GetWindowRect(window, &mut r) }.ok()?;
    Some(r)
}

/// Its visible frame, as the desktop window manager draws it.
fn visible(window: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    // SAFETY: `r` is a RECT the size we pass, as this attribute is.
    let got = unsafe { DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, (&raw mut r).cast(), size_of::<RECT>() as u32) };
    got.ok().map(|_| r).or_else(|| outer(window))
}

/// Moves `window` so its visible frame is `to`, its invisible borders around that.
fn move_to(window: HWND, to: Rect) -> Result<(), String> {
    let (outer, seen) = (outer(window).ok_or("the window is gone")?, visible(window).ok_or("the window is gone")?);
    let (left, top) = (seen.left - outer.left, seen.top - outer.top);
    let (right, bottom) = (outer.right - seen.right, outer.bottom - seen.bottom);
    // SAFETY: a window handle we were given; one that's gone, or an elevated app's, just fails.
    unsafe {
        SetWindowPos(
            window,
            None,
            to.x - left,
            to.y - top,
            to.w + left + right,
            to.h + top + bottom,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )
    }
    .map_err(|e| match e.code().0 as u32 {
        0x8007_0005 => "it belongs to an app running as administrator".to_string(),
        _ => e.message(),
    })
}

impl Desktop for Win {
    fn pointer(&mut self) -> Option<Pointer> {
        let mut at = POINT::default();
        // SAFETY: `at` is valid for the call.
        unsafe { GetCursorPos(&mut at) }.ok()?;
        // SAFETY: a plain query. With the buttons swapped, the right one is the primary.
        let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
        Some(Pointer {
            x: at.x,
            y: at.y,
            pressed: down(if swapped { VK_RBUTTON } else { VK_LBUTTON }),
            shift: down(VK_SHIFT),
            ctrl: down(VK_CONTROL),
        })
    }

    fn focused(&mut self) -> Option<Handle> {
        // SAFETY: plain queries on the foreground window, which may be null.
        unsafe {
            let window = GetForegroundWindow();
            let mut pid = 0u32;
            GetWindowThreadProcessId(window, Some(&mut pid));
            let style = GetWindowLongW(window, GWL_STYLE) as u32;
            let movable = !window.is_invalid()
                && pid != std::process::id()
                && IsWindowVisible(window).as_bool()
                && !IsIconic(window).as_bool()
                && style & WS_CHILD.0 == 0
                && style & WS_THICKFRAME.0 != 0
                && !SHELL.contains(&class(window).as_str());
            movable.then_some(window.0 as Handle)
        }
    }

    fn frame(&mut self, window: Handle) -> Option<Rect> {
        visible(hwnd(window)).map(rect)
    }

    fn place(&mut self, window: Handle, to: Rect) -> Result<(), String> {
        let window = hwnd(window);
        // SAFETY: plain calls on a window handle we were given.
        if unsafe { IsZoomed(window) }.as_bool() {
            let _ = unsafe { ShowWindow(window, SW_RESTORE) };
        }
        move_to(window, to)?;
        // On a screen of another scale, the app resized itself on the way: once more, with its new borders.
        if visible(window).map(rect) != Some(to) {
            move_to(window, to)?;
        }
        Ok(())
    }

    fn activate(&mut self, window: Handle) {
        // SAFETY: a window handle we were given; if it's gone the call just fails.
        let _ = unsafe { SetForegroundWindow(hwnd(window)) };
    }
}
