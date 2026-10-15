//! Screen captures for "screen" commands: grab the monitor under the pointer for the overlay, hand
//! the raw pixels to the page, and save finished images as PNG files.

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, Wry,
    ipc::{InvokeBody, Request, Response},
    plugin::TauriPlugin,
};

use crate::{Error, Res};

/// Width and height as little-endian u32s, ahead of the RGBA pixels in `latest`'s response.
pub const HEADER: usize = 8;

/// One monitor's pixels, and where that monitor sits on the desktop.
pub struct Capture {
    pub origin: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
    pub rgba: Vec<u8>,
}

#[derive(Default)]
struct Screen(Mutex<Option<Arc<Capture>>>);

/// Captures the monitor containing the desktop point (`x`, `y`).
pub fn capture_at(x: i32, y: i32) -> Res<Capture> {
    let fail = |e: xcap::XCapError| Error::msg(format!("screen capture: {e}"));
    let monitor = xcap::Monitor::from_point(x, y).map_err(fail)?;
    let image = monitor.capture_image().map_err(fail)?;
    Ok(Capture {
        origin: PhysicalPosition::new(monitor.x().map_err(fail)?, monitor.y().map_err(fail)?),
        size: PhysicalSize::new(image.width(), image.height()),
        rgba: image.into_raw(),
    })
}

/// Keeps `capture` as the one the overlay will show.
pub fn store(app: &AppHandle, capture: Capture) -> Arc<Capture> {
    let capture = Arc::new(capture);
    *app.state::<Screen>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&capture));
    capture
}

/// Header plus pixels, ready to send as raw bytes.
pub fn encode(capture: &Capture) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + capture.rgba.len());
    out.extend_from_slice(&capture.size.width.to_le_bytes());
    out.extend_from_slice(&capture.size.height.to_le_bytes());
    out.extend_from_slice(&capture.rgba);
    out
}

/// The latest capture as `[width u32 LE][height u32 LE][RGBA…]`, or an empty body if there is none.
#[tauri::command]
fn latest(screen: State<'_, Screen>) -> Response {
    let capture = screen.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    Response::new(capture.map(|c| encode(&c)).unwrap_or_default())
}

/// Fallback name in UTC, "Screenshot 2026-10-14 at 23.05.07.png"; the page normally sends one in local time.
pub fn file_name(unix_secs: u64) -> String {
    let (days, secs) = (unix_secs / 86_400, unix_secs % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("Screenshot {year:04}-{month:02}-{day:02} at {:02}.{:02}.{:02}.png", secs / 3600, secs % 3600 / 60, secs % 60)
}

/// A name the page proposed, if it is a plain `.png` file name (no folders, no reserved characters).
pub fn safe_name(name: &str) -> Option<String> {
    let name = name.trim();
    let ok = name.len() <= 120
        && name.to_ascii_lowercase().ends_with(".png")
        && !name.starts_with('.')
        && !name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control());
    ok.then(|| name.to_string())
}

fn screenshots_dir(app: &AppHandle) -> Res<PathBuf> {
    let base = app.path().picture_dir().or_else(|_| app.path().home_dir())?;
    Ok(base.join("Island"))
}

/// Saves the PNG in the request body to Pictures/Island, named by the `x-name` header; returns the path.
#[tauri::command]
async fn save_png(app: AppHandle, request: Request<'_>) -> Res<String> {
    let InvokeBody::Raw(png) = request.body() else { return Err(Error::msg("expected PNG bytes")) };
    let dir = screenshots_dir(&app)?;
    fs::create_dir_all(&dir)?;
    let proposed = request.headers().get("x-name").and_then(|v| v.to_str().ok()).and_then(safe_name);
    let name = proposed.unwrap_or_else(|| file_name(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())));
    let path = dir.join(name);
    fs::write(&path, png)?;
    Ok(path.to_string_lossy().into_owned())
}

crate::ipc::capture!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        app.manage(Screen::default());
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_size_ahead_of_pixels() {
        let c = Capture { origin: PhysicalPosition::new(0, 0), size: PhysicalSize::new(2, 1), rgba: vec![1, 2, 3, 4, 5, 6, 7, 8] };
        assert_eq!(encode(&c), [2, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn names_files_by_date_and_time() {
        assert_eq!(file_name(0), "Screenshot 1970-01-01 at 00.00.00.png");
        assert_eq!(file_name(1_792_019_107), "Screenshot 2026-10-14 at 23.05.07.png");
    }

    #[test]
    fn accepts_only_plain_png_names() {
        assert_eq!(safe_name("Screenshot 2026-10-14 at 23.05.07.png").as_deref(), Some("Screenshot 2026-10-14 at 23.05.07.png"));
        assert_eq!(safe_name("../evil.png"), None);
        assert_eq!(safe_name(r"C:\x.png"), None);
        assert_eq!(safe_name("notes.txt"), None);
        assert_eq!(safe_name(".png"), None);
    }

    #[test]
    #[ignore = "captures this machine's primary screen"]
    fn smoke_captures_a_monitor() {
        let c = capture_at(10, 10).expect("capture");
        assert_eq!(c.rgba.len(), (c.size.width * c.size.height * 4) as usize);
        println!("captured {}x{} at {:?}", c.size.width, c.size.height, c.origin);
    }
}
