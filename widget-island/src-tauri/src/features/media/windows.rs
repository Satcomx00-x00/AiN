//! Windows' Global System Media Transport Controls: what Spotify, browsers and players publish.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::STANDARD};
use windows::{
    Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    },
    Storage::Streams::DataReader,
};

use super::{
    Backend, Control, Read, Track,
    choose::{Candidate, choose},
};

const MAX_ART_BYTES: u64 = 4 * 1024 * 1024;
/// 100 ns ticks between 1601-01-01 (Windows epoch) and 1970-01-01.
const EPOCH_DIFF_TICKS: i64 = 116_444_736_000_000_000;

pub fn ticks_to_ms(ticks: i64) -> u64 {
    (ticks.max(0) / 10_000) as u64
}

pub fn filetime_to_unix_ms(ticks: i64) -> u64 {
    ticks_to_ms(ticks - EPOCH_DIFF_TICKS)
}

/// "Spotify.exe" → "Spotify", "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" → "ZuneMusic",
/// "C:\…\vlc.exe" → "vlc".
pub fn app_name(id: &str) -> String {
    let id = id.split('!').next().unwrap_or(id);
    let id = id.rsplit(['\\', '/']).next().unwrap_or(id);
    let id = match id.len().checked_sub(4) {
        Some(cut) if id.is_char_boundary(cut) && id[cut..].eq_ignore_ascii_case(".exe") => &id[..cut],
        _ => id.split('_').next().unwrap_or(id).rsplit('.').next().unwrap_or(id),
    };
    id.to_string()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

pub struct Source {
    manager: Manager,
    artwork_key: Option<String>,
}

impl Source {
    pub fn new() -> Option<Self> {
        let manager = Manager::RequestAsync().ok()?.join().ok()?;
        Some(Self { manager, artwork_key: None })
    }

    fn session(&self) -> Option<Session> {
        let sessions: Vec<Session> = self.manager.GetSessions().ok()?.into_iter().collect();
        let current = self.manager.GetCurrentSession().and_then(|s| s.SourceAppUserModelId()).ok();
        let candidates: Vec<Candidate> = sessions
            .iter()
            .map(|s| {
                let id = s.SourceAppUserModelId().unwrap_or_default();
                Candidate { app: app_name(&id.to_string()), playing: playing(s), current: current.as_ref() == Some(&id) }
            })
            .collect();
        sessions.into_iter().nth(choose(&candidates)?)
    }
}

impl Backend for Source {
    fn read(&mut self) -> Read {
        let found = self.session().and_then(|s| {
            let props = s.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
            Some((track(&s, &props)?, props))
        });
        let Some((track, props)) = found else {
            let artwork = self.artwork_key.take().map(|_| None);
            return Read { track: None, artwork };
        };
        let artwork = (self.artwork_key.as_ref() != Some(&track.artwork_key)).then(|| {
            self.artwork_key = Some(track.artwork_key.clone());
            thumbnail(&props)
        });
        Read { track: Some(track), artwork }
    }

    fn control(&mut self, control: Control) {
        let Some(s) = self.session() else { return };
        let op = match control {
            Control::Toggle => s.TryTogglePlayPauseAsync(),
            Control::Next => s.TrySkipNextAsync(),
            Control::Previous => s.TrySkipPreviousAsync(),
        };
        let _ = op.and_then(|op| op.join());
    }
}

fn playing(s: &Session) -> bool {
    s.GetPlaybackInfo().and_then(|p| p.PlaybackStatus()).is_ok_and(|st| st == Status::Playing)
}

fn track(s: &Session, props: &Properties) -> Option<Track> {
    let text = |r: windows::core::Result<windows::core::HSTRING>| r.map(|h| h.to_string()).unwrap_or_default();
    let title = text(props.Title());
    if title.is_empty() {
        return None;
    }
    let (artist, album) = (text(props.Artist()), text(props.AlbumTitle()));
    let app = app_name(&text(s.SourceAppUserModelId()));
    let timeline = s.GetTimelineProperties().ok();
    let position_ms = timeline.as_ref().and_then(|t| t.Position().ok()).map_or(0, |p| ticks_to_ms(p.Duration));
    let duration_ms = timeline.as_ref().and_then(|t| t.EndTime().ok()).map_or(0, |p| ticks_to_ms(p.Duration));
    let measured_at = timeline
        .as_ref()
        .and_then(|t| t.LastUpdatedTime().ok())
        .map(|d| filetime_to_unix_ms(d.UniversalTime))
        .filter(|&ms| ms > 0)
        .unwrap_or_else(now_ms);
    let artwork_key = format!("{app}\u{1f}{title}\u{1f}{artist}\u{1f}{album}");
    Some(Track { title, artist, album, app, playing: playing(s), position_ms, duration_ms, measured_at, artwork_key })
}

fn thumbnail(props: &Properties) -> Option<String> {
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.join().ok()?;
    let size = stream.Size().ok().filter(|&n| n > 0 && n <= MAX_ART_BYTES)? as u32;
    let mime = stream.ContentType().map(|m| m.to_string()).ok().filter(|m| !m.is_empty()).unwrap_or_else(|| "image/png".into());
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size).ok()?.join().ok()?;
    let mut bytes = vec![0; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_ticks() {
        assert_eq!(ticks_to_ms(12_345_678), 1234);
        assert_eq!(ticks_to_ms(-5), 0);
    }

    #[test]
    #[ignore = "reads this machine's live media sessions"]
    fn smoke_reads_live_session() {
        let mut source = Source::new().expect("media session manager");
        let read = source.read();
        println!("track: {:?}", read.track);
        println!("artwork: {:?}", read.artwork.flatten().map(|a| a.len()));
    }

    #[test]
    fn converts_filetime_to_unix() {
        assert_eq!(filetime_to_unix_ms(EPOCH_DIFF_TICKS + 10_000_000), 1000);
    }

    #[test]
    fn names_apps_from_their_ids() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "ZuneMusic");
        assert_eq!(app_name(r"C:\Program Files\VideoLAN\VLC\vlc.EXE"), "vlc");
        assert_eq!(app_name("Chrome"), "Chrome");
    }
}
