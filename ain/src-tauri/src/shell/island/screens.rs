//! The screens the pill can sit on, and the one it does: the screen picked in Settings while it is
//! connected, else the primary one, else the first listed.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::Monitor;
use tauri_specta::Event;

/// A connected screen, as Settings lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    /// What the setting saves: the screen's name, with " #2", " #3"… on screens that share it, so
    /// it survives restarts and rearranging the screens.
    pub id: String,
    /// Its model or output name; empty when the system gives none.
    pub name: String,
    /// Its resolution, in device pixels.
    pub width: u32,
    pub height: u32,
    /// Its top-left corner on the desktop, in device pixels.
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub primary: bool,
}

/// The screens connected now, sent when one is plugged in or out, or rearranged.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ScreensChanged(pub Vec<Screen>);

/// Each name (or "Screen" for none), then " #n" from its second appearance on.
pub fn ids(names: &[String]) -> Vec<String> {
    let mut seen = HashMap::<&str, usize>::new();
    names
        .iter()
        .map(|n| {
            let base = match n.trim() {
                "" => "Screen",
                name => name,
            };
            let count = seen.entry(base).and_modify(|c| *c += 1).or_insert(1);
            if *count == 1 { base.to_owned() } else { format!("{base} #{count}") }
        })
        .collect()
}

/// `monitors` in order, as screens; `primary` is matched by position, which no two screens share.
pub fn describe(monitors: &[Monitor], primary: Option<&Monitor>) -> Vec<Screen> {
    let names: Vec<String> = monitors.iter().map(|m| m.name().cloned().unwrap_or_default()).collect();
    ids(&names)
        .into_iter()
        .zip(names)
        .zip(monitors)
        .map(|((id, name), m)| {
            let (pos, size) = (*m.position(), *m.size());
            Screen {
                id,
                name,
                width: size.width,
                height: size.height,
                x: pos.x,
                y: pos.y,
                scale: m.scale_factor(),
                primary: primary.is_some_and(|p| *p.position() == pos),
            }
        })
        .collect()
}

/// The index of the screen to use: `wanted` while connected, else the primary, else the one at the
/// desktop's origin (GNOME on Wayland names no primary), else the first.
pub fn pick(screens: &[Screen], wanted: Option<&str>) -> Option<usize> {
    let find = |f: &dyn Fn(&Screen) -> bool| screens.iter().position(f);
    wanted
        .and_then(|w| find(&|s| s.id == w))
        .or_else(|| find(&|s| s.primary))
        .or_else(|| find(&|s| s.x == 0 && s.y == 0))
        .or_else(|| (!screens.is_empty()).then_some(0))
}

/// The screen picked in Settings (`general.screen`); `None` for the primary.
pub fn wanted(settings: &Value) -> Option<String> {
    settings.get("general")?.get("screen")?.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn screen(id: &str, x: i32, primary: bool) -> Screen {
        Screen { id: id.into(), name: id.into(), width: 1920, height: 1080, x, y: 0, scale: 1.0, primary }
    }

    #[test]
    fn repeated_names_get_numbered() {
        let names = ["DELL U2720Q", "", "DELL U2720Q", " "].map(String::from);
        assert_eq!(ids(&names), ["DELL U2720Q", "Screen", "DELL U2720Q #2", "Screen #2"]);
    }

    #[test]
    fn picks_the_wanted_screen_while_connected() {
        let screens = [screen("A", 0, true), screen("B", 1920, false)];
        assert_eq!(pick(&screens, Some("B")), Some(1));
    }

    #[test]
    fn falls_back_to_the_primary_when_unplugged_or_unset() {
        let screens = [screen("A", -1920, false), screen("B", 0, true)];
        assert_eq!(pick(&screens, Some("gone")), Some(1));
        assert_eq!(pick(&screens, None), Some(1));
    }

    #[test]
    fn without_a_primary_takes_the_origin_then_the_first() {
        assert_eq!(pick(&[screen("A", -1920, false), screen("B", 0, false)], None), Some(1));
        assert_eq!(pick(&[screen("A", 100, false), screen("B", 2020, false)], None), Some(0));
        assert_eq!(pick(&[], Some("A")), None);
    }

    #[test]
    fn reads_the_setting() {
        assert_eq!(wanted(&json!({ "general": { "screen": "B" } })), Some("B".into()));
        assert_eq!(wanted(&json!({ "general": { "screen": null } })), None);
        assert_eq!(wanted(&json!({ "general": { "screen": "" } })), None);
        assert_eq!(wanted(&Value::Null), None);
    }
}
