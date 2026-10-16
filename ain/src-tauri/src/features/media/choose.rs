//! Which of several players to show, the same way on every platform.

/// Spotify wins when several sessions are equally relevant.
const PREFERRED: &str = "Spotify";

/// A player session, as far as choosing which one to show is concerned.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub app: String,
    pub playing: bool,
    /// The session the OS itself considers current.
    pub current: bool,
}

/// Prefers what is playing, then Spotify, then the OS's current session.
pub fn choose(candidates: &[Candidate]) -> Option<usize> {
    let rank = |c: &Candidate| (c.playing, c.app == PREFERRED, c.current);
    (0..candidates.len()).rev().max_by_key(|&i| rank(&candidates[i]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(app: &str, playing: bool, current: bool) -> Candidate {
        Candidate { app: app.into(), playing, current }
    }

    #[test]
    fn prefers_playing_over_current() {
        assert_eq!(choose(&[c("Chrome", false, true), c("vlc", true, false)]), Some(1));
    }

    #[test]
    fn prefers_spotify_among_playing() {
        assert_eq!(choose(&[c("Chrome", true, true), c("Spotify", true, false)]), Some(1));
    }

    #[test]
    fn falls_back_to_current_then_first() {
        assert_eq!(choose(&[c("A", false, false), c("B", false, true)]), Some(1));
        assert_eq!(choose(&[c("A", false, false), c("B", false, false)]), Some(0));
        assert_eq!(choose(&[]), None);
    }
}
