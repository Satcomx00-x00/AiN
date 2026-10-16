//! MPRIS: the D-Bus interface Linux players publish (Spotify, Firefox, Chromium, VLC, mpv…).

use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use mpris::{Metadata, PlaybackStatus, Player, PlayerFinder};

use super::{
    Backend, Control, Read, Track, art,
    choose::{Candidate, choose},
};

pub struct Players {
    finder: PlayerFinder,
    artwork_key: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn playing(p: &Player) -> bool {
    matches!(p.get_playback_status(), Ok(PlaybackStatus::Playing))
}

impl Players {
    pub fn new() -> Option<Self> {
        Some(Self { finder: PlayerFinder::new().ok()?, artwork_key: None })
    }

    fn player(&self) -> Option<Player> {
        let players = self.finder.find_all().ok()?;
        // MPRIS has no notion of a "current" session; what plays and the preferred app decide.
        let candidates: Vec<Candidate> =
            players.iter().map(|p| Candidate { app: p.identity().to_string(), playing: playing(p), current: false }).collect();
        players.into_iter().nth(choose(&candidates)?)
    }
}

/// What identifies the artwork: its URL when the player gives one, else the track itself.
pub fn artwork_key(app: &str, meta: &Metadata) -> String {
    match meta.art_url() {
        Some(url) if !url.is_empty() => url.to_string(),
        _ => format!("{app}\u{1f}{}\u{1f}{}", meta.title().unwrap_or_default(), meta.album_name().unwrap_or_default()),
    }
}

fn track(p: &Player, meta: &Metadata) -> Option<Track> {
    let title = meta.title().unwrap_or_default().to_string();
    if title.is_empty() {
        return None;
    }
    let app = p.identity().to_string();
    Some(Track {
        artist: meta.artists().map(|a| a.join(", ")).unwrap_or_default(),
        album: meta.album_name().unwrap_or_default().to_string(),
        playing: playing(p),
        position_ms: p.get_position().map_or(0, |d| d.as_millis() as u64),
        duration_ms: meta.length().map_or(0, |d| d.as_millis() as u64),
        measured_at: now_ms(),
        artwork_key: artwork_key(&app, meta),
        title,
        app,
    })
}

/// The artwork as a `data:` URL: players point at a local file or an http(s) URL.
fn thumbnail(url: &str) -> Option<String> {
    let Some(path) = url.strip_prefix("file://") else { return art::download(url) };
    let path = percent_decode(path);
    let bytes = fs::metadata(&path).ok().filter(|m| m.len() <= art::MAX_BYTES).and_then(|_| fs::read(&path).ok())?;
    Some(art::data_url(art::mime_for(&path), &bytes))
}

/// File URLs escape spaces and other bytes as `%XX`.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && let (Some(h), Some(l)) = (bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Backend for Players {
    fn read(&mut self) -> Read {
        let found = self.player().and_then(|p| {
            let meta = p.get_metadata().ok()?;
            Some((track(&p, &meta)?, meta))
        });
        let Some((track, meta)) = found else {
            let artwork = self.artwork_key.take().map(|_| None);
            return Read { track: None, artwork };
        };
        let artwork = (self.artwork_key.as_ref() != Some(&track.artwork_key)).then(|| {
            self.artwork_key = Some(track.artwork_key.clone());
            meta.art_url().and_then(thumbnail)
        });
        Read { track: Some(track), artwork }
    }

    fn control(&mut self, control: Control) {
        let Some(p) = self.player() else { return };
        let _ = match control {
            Control::Toggle => p.play_pause(),
            Control::Next => p.next(),
            Control::Previous => p.previous(),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_file_urls() {
        assert_eq!(percent_decode("/home/me/My%20Music/cover%2Ejpg"), "/home/me/My Music/cover.jpg");
        assert_eq!(percent_decode("/bad%zzescape%"), "/bad%zzescape%");
    }

    #[test]
    #[ignore = "reads this machine's live MPRIS players"]
    fn smoke_reads_live_players() {
        let mut players = Players::new().expect("session bus");
        let read = players.read();
        println!("track: {:?}", read.track);
        println!("artwork: {:?}", read.artwork.flatten().map(|a| a.len()));
    }
}
