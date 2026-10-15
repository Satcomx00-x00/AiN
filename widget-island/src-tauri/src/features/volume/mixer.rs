//! What every backend's mixer has in common: levels, app names and display order.

use super::{Source, SourceKind};

pub fn round_level(level: f32) -> f32 {
    (level.clamp(0.0, 1.0) * 100.0).round() / 100.0
}

/// A program's id and label: "Spotify.exe" → ("app:spotify", "Spotify"); "firefox" → ("app:firefox", "Firefox").
pub fn app_identity(program: &str) -> (String, String) {
    let file = program.rsplit(['\\', '/']).next().unwrap_or(program);
    let stem = match file.len().checked_sub(4) {
        Some(cut) if file.is_char_boundary(cut) && file[cut..].eq_ignore_ascii_case(".exe") => &file[..cut],
        _ => file,
    };
    let mut label = stem.to_string();
    if let Some(first) = label.get(..1) {
        label.replace_range(..1, &first.to_uppercase());
    }
    (format!("app:{}", stem.to_lowercase()), label)
}

/// Devices first (the default one leading), then apps — those playing first — each alphabetically.
pub fn sort(sources: &mut [Source]) {
    sources.sort_by(|a, b| {
        let rank = |s: &Source| (s.kind == SourceKind::App, !s.default, !s.active);
        rank(a).cmp(&rank(b)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_and_clamps_levels() {
        assert_eq!(round_level(0.456_78), 0.46);
        assert_eq!(round_level(1.2), 1.0);
        assert_eq!(round_level(-0.1), 0.0);
    }

    #[test]
    fn names_apps_from_their_programs() {
        assert_eq!(app_identity("Spotify.exe"), ("app:spotify".into(), "Spotify".into()));
        assert_eq!(app_identity(r"C:\Program Files\Discord\discord.EXE"), ("app:discord".into(), "Discord".into()));
        assert_eq!(app_identity("/usr/lib/firefox/firefox"), ("app:firefox".into(), "Firefox".into()));
    }

    fn s(id: &str, kind: SourceKind, default: bool, active: bool) -> Source {
        Source { id: id.into(), kind, name: id.into(), level: 1.0, muted: false, default, active }
    }

    #[test]
    fn sorts_default_device_first_then_devices_then_playing_apps() {
        let mut list = vec![
            s("zoom", SourceKind::App, false, false),
            s("spotify", SourceKind::App, false, true),
            s("chat", SourceKind::Device, false, true),
            s("gaming", SourceKind::Device, true, true),
        ];
        sort(&mut list);
        let order: Vec<&str> = list.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(order, ["gaming", "chat", "spotify", "zoom"]);
    }
}
