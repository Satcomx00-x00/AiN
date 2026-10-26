//! The conversation itself: a WebSocket to a PersonaPlex server (`/api/chat`, as Moshi's), carrying
//! the microphone up and the voice down as Ogg Opus, both at once, plus the words it says.
//!
//! Every message is binary, its first byte its kind. The server sends a handshake once it has taken
//! the persona (which can take a few seconds), then audio and text for as long as it lasts.

use std::{
    io,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};

use tungstenite::{Message, WebSocket, http::Uri, stream::MaybeTlsStream};

use super::{
    Phase,
    codec::{self, Decoder, Encoder},
};
use crate::features::{audio, lock, microphone::Captured, speakers::Queue};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The server loads the voice and reads the persona before it answers.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a read waits for the server before the microphone gets its turn again.
const POLL: Duration = Duration::from_millis(10);
/// How often the level and the words are reported, at most.
const REPORT_EVERY: Duration = Duration::from_millis(50);
/// How much of what the voice says the island shows.
const SAID_CHARS: usize = 120;

const HANDSHAKE: u8 = 0x00;
const AUDIO: u8 = 0x01;
const TEXT: u8 = 0x02;
const ERROR: u8 = 0x05;

/// A message from the server, by kind.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming<'a> {
    Handshake,
    Audio(&'a [u8]),
    Text(String),
    Error(String),
    /// Control, metadata, pings: nothing to act on.
    Other,
}

impl<'a> Incoming<'a> {
    pub fn parse(bytes: &'a [u8]) -> Self {
        let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
        match bytes.split_first() {
            Some((&HANDSHAKE, _)) => Self::Handshake,
            Some((&AUDIO, rest)) => Self::Audio(rest),
            Some((&TEXT, rest)) => Self::Text(text(rest)),
            Some((&ERROR, rest)) => Self::Error(text(rest)),
            _ => Self::Other,
        }
    }
}

/// Percent-encodes a query value (RFC 3986: all but the unreserved characters).
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => char::from(b).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Who the voice is: one of the server's voices, and the role it plays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Persona {
    pub voice: String,
    pub prompt: String,
}

/// The conversation's address on `server`, which may be written as `host:port`, `ws(s)://…` or
/// `http(s)://…`.
pub fn address(server: &str, persona: &Persona) -> Result<String, String> {
    let server = server.trim().trim_end_matches('/');
    let base = match server.split_once("://") {
        Some(("ws" | "http", rest)) => format!("ws://{rest}"),
        Some(("wss" | "https", rest)) => format!("wss://{rest}"),
        Some((scheme, _)) => return Err(format!("A PersonaPlex server's address starts with ws:// or wss://, not {scheme}://")),
        None if server.is_empty() => return Err("Set the PersonaPlex server's address in Settings".into()),
        None => format!("ws://{server}"),
    };
    let url = format!("{base}/api/chat?voice_prompt={}.pt&text_prompt={}", encode(&persona.voice), encode(&persona.prompt));
    url.parse::<Uri>().map_err(|_| format!("“{server}” isn't a server address"))?;
    Ok(url)
}

/// Where the conversation's audio comes from and goes to.
pub struct Ends {
    pub mic: Captured,
    pub mic_rate: u32,
    pub speakers: Queue,
    pub speaker_rate: u32,
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

fn addresses(uri: &Uri) -> Result<Vec<SocketAddr>, String> {
    let host = uri.host().ok_or("The server's address has no host")?.trim_matches(['[', ']']);
    let port = uri.port_u16().unwrap_or(if uri.scheme_str() == Some("wss") { 443 } else { 80 });
    (host, port).to_socket_addrs().map(Iterator::collect).map_err(|e| format!("Couldn't find {host}: {e}"))
}

/// Opens the WebSocket; its reads then give up after `POLL`, so one thread can listen and talk.
fn connect(url: &str) -> Result<Socket, String> {
    let uri: Uri = url.parse().map_err(|_| "The server's address isn't valid".to_string())?;
    let unreachable = || format!("Couldn't reach the PersonaPlex server at {}", uri.authority().map_or("", |a| a.as_str()));
    let tcp = addresses(&uri)?.iter().find_map(|a| TcpStream::connect_timeout(a, CONNECT_TIMEOUT).ok()).ok_or_else(unreachable)?;
    // The clone shares the socket: it sets timeouts once TLS and the WebSocket wrap the original.
    let control = tcp.try_clone().map_err(|e| e.to_string())?;
    control.set_read_timeout(Some(CONNECT_TIMEOUT)).map_err(|e| e.to_string())?;
    let _ = control.set_nodelay(true);
    let (socket, _) = tungstenite::client_tls(url, tcp).map_err(|e| format!("The server refused the conversation: {e}"))?;
    control.set_read_timeout(Some(POLL)).map_err(|e| e.to_string())?;
    Ok(socket)
}

/// The next message, or `None` when none came within `POLL`.
fn next(socket: &mut Socket) -> Result<Option<Vec<u8>>, String> {
    match socket.read() {
        Ok(Message::Binary(bytes)) => Ok(Some(bytes.to_vec())),
        Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
            Err("The server ended the conversation".into())
        }
        Ok(_) => Ok(Some(Vec::new())),
        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => Ok(None),
        Err(e) => Err(format!("The conversation broke off: {e}")),
    }
}

/// The last words the voice said, as the island shows them.
#[derive(Debug, Default)]
struct Said(String);

impl Said {
    fn push(&mut self, piece: &str) {
        self.0.push_str(piece);
        let chars = self.0.chars().count();
        if chars > SAID_CHARS {
            let cut = self.0.char_indices().nth(chars - SAID_CHARS).map_or(0, |(i, _)| i);
            self.0.drain(..cut);
        }
    }

    fn text(&self) -> String {
        self.0.trim().to_string()
    }
}

/// Holds the conversation until `current` turns false (Ok) or it fails (Err), reporting its phase.
pub fn run(url: &str, ends: &Ends, current: impl Fn() -> bool, mut report: impl FnMut(Phase)) -> Result<(), String> {
    report(Phase::Connecting);
    let mut socket = connect(url)?;
    let asked = Instant::now();
    loop {
        if !current() {
            hang_up(&mut socket);
            return Ok(());
        }
        // What was said before the voice is ready isn't heard.
        lock(&ends.mic).clear();
        match next(&mut socket)? {
            Some(bytes) => match Incoming::parse(&bytes) {
                Incoming::Handshake => break,
                Incoming::Error(message) => return Err(message),
                _ => {}
            },
            None if asked.elapsed() > HANDSHAKE_TIMEOUT => return Err("The PersonaPlex server didn't answer in time".into()),
            None => {}
        }
    }
    let (mut encoder, mut decoder) = (Encoder::new()?, Decoder::new()?);
    let (mut said, mut level, mut reported) = (Said::default(), 0.0_f32, None::<Instant>);
    while current() {
        let heard = std::mem::take(&mut *lock(&ends.mic));
        let heard = audio::resample(&heard, ends.mic_rate, codec::RATE);
        if !heard.is_empty() {
            level = level.max(audio::level(&heard));
        }
        let up = encoder.push(&heard)?;
        if !up.is_empty() {
            socket.send(Message::binary([&[AUDIO], up.as_slice()].concat())).map_err(|e| format!("The conversation broke off: {e}"))?;
        }
        while let Some(bytes) = next(&mut socket)? {
            match Incoming::parse(&bytes) {
                Incoming::Audio(ogg) => lock(&ends.speakers).extend(audio::resample(&decoder.push(ogg)?, codec::RATE, ends.speaker_rate)),
                Incoming::Text(piece) => said.push(&piece),
                Incoming::Error(message) => return Err(message),
                Incoming::Handshake | Incoming::Other => {}
            }
        }
        if reported.is_none_or(|at| at.elapsed() >= REPORT_EVERY) {
            let speaking = !lock(&ends.speakers).is_empty();
            // Rounded so the event only fires when something visible changes.
            report(Phase::Live { level: (level * 20.0).round() / 20.0, speaking, said: said.text() });
            (level, reported) = (0.0, Some(Instant::now()));
        }
    }
    hang_up(&mut socket);
    Ok(())
}

/// Says goodbye; a server already gone doesn't need to hear it.
fn hang_up(socket: &mut Socket) {
    let _ = socket.close(None);
    let _ = socket.flush();
}

#[cfg(test)]
mod tests {
    use std::{
        net::TcpListener,
        sync::{Arc, Mutex, mpsc},
        thread,
    };

    use super::*;

    fn persona() -> Persona {
        Persona { voice: "NATF2".into(), prompt: "You are a calm & kind tutor.".into() }
    }

    #[test]
    fn addresses_the_chat_with_the_persona() {
        let url = "/api/chat?voice_prompt=NATF2.pt&text_prompt=You%20are%20a%20calm%20%26%20kind%20tutor.";
        assert_eq!(address("localhost:8998", &persona()).unwrap(), format!("ws://localhost:8998{url}"));
        assert_eq!(address(" https://gpu.example.com/ ", &persona()).unwrap(), format!("wss://gpu.example.com{url}"));
        assert_eq!(address("http://10.0.0.2:8998", &persona()).unwrap(), format!("ws://10.0.0.2:8998{url}"));
        assert_eq!(address("wss://a.b", &persona()).unwrap(), format!("wss://a.b{url}"));
    }

    #[test]
    fn says_what_is_wrong_with_an_address() {
        assert_eq!(address("  ", &persona()).unwrap_err(), "Set the PersonaPlex server's address in Settings");
        assert!(address("ftp://x", &persona()).unwrap_err().contains("not ftp://"));
        assert!(address("bad host", &persona()).unwrap_err().contains("isn't a server address"));
    }

    #[test]
    fn reads_messages_by_kind() {
        assert_eq!(Incoming::parse(&[0]), Incoming::Handshake);
        assert_eq!(Incoming::parse(&[1, 9, 8]), Incoming::Audio(&[9, 8]));
        assert_eq!(Incoming::parse(b"\x02 hello"), Incoming::Text(" hello".into()));
        assert_eq!(Incoming::parse(b"\x05busy"), Incoming::Error("busy".into()));
        assert_eq!(Incoming::parse(&[6]), Incoming::Other);
        assert_eq!(Incoming::parse(&[]), Incoming::Other);
    }

    #[test]
    fn keeps_the_last_words() {
        let mut said = Said::default();
        said.push(" Hello");
        said.push(" there");
        assert_eq!(said.text(), "Hello there");
        said.push(&"é".repeat(SAID_CHARS));
        assert_eq!(said.text(), "é".repeat(SAID_CHARS));
    }

    fn ends() -> Ends {
        Ends { mic: Arc::new(Mutex::new(Vec::new())), mic_rate: codec::RATE, speakers: Queue::default(), speaker_rate: codec::RATE }
    }

    /// A PersonaPlex server on this machine for one conversation: it answers with `script` after
    /// the request, then echoes the audio it hears with a word. Returns its address and the request.
    #[allow(clippy::result_large_err, reason = "tungstenite's callback type")]
    fn server(script: Vec<Vec<u8>>) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let at = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept_hdr(tcp, |req: &tungstenite::handshake::server::Request, res| {
                let _ = tx.send(req.uri().to_string());
                Ok(res)
            })
            .unwrap();
            for message in script {
                socket.send(Message::binary(message)).unwrap();
            }
            while let Ok(Message::Binary(bytes)) = socket.read() {
                if let Incoming::Audio(ogg) = Incoming::parse(&bytes) {
                    socket.send(Message::binary([&[AUDIO], ogg].concat())).unwrap();
                    socket.send(Message::binary(b"\x02 hi".to_vec())).unwrap();
                }
            }
        });
        (address(&format!("127.0.0.1:{}", at.port()), &persona()).unwrap(), rx)
    }

    #[test]
    fn talks_and_listens_at_once() {
        let (url, request) = server(vec![vec![HANDSHAKE]]);
        let ends = ends();
        let phases = Mutex::new(Vec::new());
        let heard = || {
            !lock(&ends.speakers).is_empty() && lock(&phases).iter().any(|p| matches!(p, Phase::Live { said, .. } if said.contains("hi")))
        };
        let report = |phase: Phase| {
            // Once live, the user speaks for a second.
            if matches!(phase, Phase::Live { .. }) && lock(&phases).len() == 1 {
                lock(&ends.mic).extend(vec![0.3_f32; codec::RATE as usize]);
            }
            lock(&phases).push(phase);
        };
        let start = Instant::now();
        run(&url, &ends, || !heard() && start.elapsed() < Duration::from_secs(10), report).unwrap();
        assert!(heard(), "the voice came back, with its words: {:?}", lock(&phases));
        assert!(request.recv().unwrap().ends_with("voice_prompt=NATF2.pt&text_prompt=You%20are%20a%20calm%20%26%20kind%20tutor."));
        assert_eq!(lock(&phases)[0], Phase::Connecting);
        assert!(lock(&phases).iter().any(|p| matches!(p, Phase::Live { level, .. } if *level > 0.5)), "the user's level shows");
    }

    #[test]
    fn passes_on_the_server_s_refusal() {
        let (url, _) = server(vec![b"\x05No GPU left".to_vec()]);
        assert_eq!(run(&url, &ends(), || true, |_| {}).unwrap_err(), "No GPU left");
    }

    #[test]
    fn passes_on_errors_and_stops_when_asked() {
        let (url, _) = server(vec![vec![HANDSHAKE], b"\x05Too many people".to_vec()]);
        assert_eq!(run(&url, &ends(), || true, |_| {}).unwrap_err(), "Too many people");
        let (url, _) = server(Vec::new());
        // The server's thread is waiting for audio that never comes before the handshake: stop asking.
        let stop = Instant::now();
        run(&url, &ends(), || stop.elapsed() < Duration::from_millis(200), |_| {}).unwrap();
    }

    #[test]
    fn says_when_the_server_hangs_up() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let mut socket = tungstenite::accept(listener.accept().unwrap().0).unwrap();
            socket.send(Message::binary(vec![HANDSHAKE])).unwrap();
            socket.close(None).unwrap();
            while socket.read().is_ok() {}
        });
        let url = address(&format!("127.0.0.1:{port}"), &persona()).unwrap();
        assert_eq!(run(&url, &ends(), || true, |_| {}).unwrap_err(), "The server ended the conversation");
    }

    #[test]
    fn says_when_no_server_answers() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let url = address(&format!("127.0.0.1:{port}"), &persona()).unwrap();
        assert!(run(&url, &ends(), || true, |_| {}).unwrap_err().starts_with("Couldn't reach the PersonaPlex server"));
    }
}
