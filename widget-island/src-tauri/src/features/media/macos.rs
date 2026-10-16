//! macOS keeps the system's Now Playing to itself (MediaRemote is closed to other apps since 15.4),
//! so we ask the players that can be scripted, Spotify and Music, through `osascript`. Each one asks
//! the user once whether AiN may control it.

use std::{
    fs,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;

use super::{
    Backend, Control, Read, Track, art,
    choose::{Candidate, choose},
};
use crate::platform::macos::running;

/// Spotify's and Music's bundle ids: while neither runs, there is nothing to ask.
const PLAYERS: [&str; 2] = ["com.spotify.client", "com.apple.Music"];

/// Every running player that has a track, as JSON. `running()` doesn't launch the app, and needs no
/// permission. Spotify measures durations in milliseconds, Music in seconds.
const READ: &str = r#"
const read = (name) => {
  const app = Application(name);
  if (!app.running()) return [];
  const state = app.playerState();
  if (state === "stopped") return [];
  const track = app.currentTrack;
  return [{
    app: name,
    playing: state === "playing",
    title: track.name(),
    artist: track.artist(),
    album: track.album(),
    positionMs: Math.round(app.playerPosition() * 1000),
    durationMs: Math.round(track.duration() * (name === "Spotify" ? 1 : 1000)),
    artworkUrl: name === "Spotify" ? track.artworkUrl() : "",
  }];
};
JSON.stringify(["Spotify", "Music"].flatMap((name) => { try { return read(name); } catch (e) { return []; } }));
"#;

/// Music hands its artwork over as raw bytes, which AppleScript writes to the file given.
const MUSIC_ARTWORK: &str = r#"
on run argv
  tell application "Music" to set art to raw data of artwork 1 of current track
  set f to open for access (POSIX file (item 1 of argv)) with write permission
  try
    set eof f to 0
    write art to f
  end try
  close access f
end run
"#;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Player {
    pub app: String,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub artwork_url: String,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn osascript(language: &str, script: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("osascript")
        .args(["-l", language, "-e", script])
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn players() -> Vec<Player> {
    if !running(&PLAYERS) {
        return Vec::new();
    }
    osascript("JavaScript", READ, &[]).and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
}

/// The player to show, as on every platform: what plays, then Spotify.
fn chosen(players: Vec<Player>) -> Option<Player> {
    let candidates: Vec<Candidate> = players.iter().map(|p| Candidate { app: p.app.clone(), playing: p.playing, current: false }).collect();
    players.into_iter().nth(choose(&candidates)?)
}

/// What identifies the artwork: its URL when the player gives one, else the track itself.
pub fn artwork_key(p: &Player) -> String {
    match p.artwork_url.as_str() {
        "" => format!("{}\u{1f}{}\u{1f}{}", p.app, p.title, p.album),
        url => url.to_string(),
    }
}

pub fn track(p: &Player, measured_at: u64) -> Option<Track> {
    (!p.title.is_empty()).then(|| Track {
        title: p.title.clone(),
        artist: p.artist.clone(),
        album: p.album.clone(),
        app: p.app.clone(),
        playing: p.playing,
        position_ms: p.position_ms,
        duration_ms: p.duration_ms,
        measured_at,
        artwork_key: artwork_key(p),
    })
}

fn thumbnail(p: &Player) -> Option<String> {
    if !p.artwork_url.is_empty() {
        return art::download(&p.artwork_url);
    }
    if p.app != "Music" {
        return None;
    }
    let file = std::env::temp_dir().join(format!("island-artwork-{}", std::process::id()));
    let written = osascript("AppleScript", MUSIC_ARTWORK, &[file.to_str()?]);
    let bytes = written.and_then(|_| fs::metadata(&file).ok()).filter(|m| m.len() <= art::MAX_BYTES).and_then(|_| fs::read(&file).ok());
    let _ = fs::remove_file(&file);
    bytes.filter(|b| !b.is_empty()).map(|b| art::data_url(art::sniff(&b), &b))
}

#[derive(Default)]
pub struct Players {
    artwork_key: Option<String>,
}

impl Backend for Players {
    fn read(&mut self) -> Read {
        let Some((track, player)) = chosen(players()).and_then(|p| Some((track(&p, now_ms())?, p))) else {
            let artwork = self.artwork_key.take().map(|_| None);
            return Read { track: None, artwork };
        };
        let artwork = (self.artwork_key.as_ref() != Some(&track.artwork_key)).then(|| {
            self.artwork_key = Some(track.artwork_key.clone());
            thumbnail(&player)
        });
        Read { track: Some(track), artwork }
    }

    fn control(&mut self, control: Control) {
        let Some(player) = chosen(players()) else { return };
        let action = match control {
            Control::Toggle => "playpause",
            Control::Next => "nextTrack",
            Control::Previous => "previousTrack",
        };
        let _ = osascript("JavaScript", &format!("Application({:?}).{action}()", player.app), &[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player(app: &str, playing: bool, artwork_url: &str) -> Player {
        Player {
            app: app.into(),
            playing,
            title: "Song".into(),
            album: "Album".into(),
            artwork_url: artwork_url.into(),
            ..Player::default()
        }
    }

    #[test]
    fn reads_the_players_answer() {
        let json = r#"[{"app":"Music","playing":false,"title":"Song","artist":"A","album":"B","positionMs":1500,"durationMs":200000,"artworkUrl":""}]"#;
        let players: Vec<Player> = serde_json::from_str(json).unwrap();
        let track = track(&players[0], 7).unwrap();
        assert_eq!((track.position_ms, track.duration_ms, track.measured_at), (1500, 200_000, 7));
        assert_eq!(track.artwork_key, "Music\u{1f}Song\u{1f}B");
    }

    #[test]
    fn shows_what_plays_then_spotify() {
        let pick = |players: Vec<Player>| chosen(players).map(|p| p.app);
        assert_eq!(pick(vec![player("Spotify", false, ""), player("Music", true, "")]).as_deref(), Some("Music"));
        assert_eq!(pick(vec![player("Music", false, ""), player("Spotify", false, "")]).as_deref(), Some("Spotify"));
        assert_eq!(pick(Vec::new()), None);
    }

    #[test]
    fn keys_artwork_by_its_url_when_there_is_one() {
        assert_eq!(artwork_key(&player("Spotify", true, "https://i.scdn.co/image/x")), "https://i.scdn.co/image/x");
    }

    #[test]
    #[ignore = "reads this machine's live players"]
    fn smoke_reads_live_players() {
        let read = Players::default().read();
        println!("track: {:?}", read.track);
        println!("artwork: {:?}", read.artwork.flatten().map(|a| a.len()));
    }
}
