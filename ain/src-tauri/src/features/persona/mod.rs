//! Conversation: talk with NVIDIA PersonaPlex, a full-duplex speech-to-speech model, as with a
//! person. It listens while it speaks, so the user can interrupt it, and it backchannels. The model
//! (7B, a GPU with 24 GB) runs on a PersonaPlex server, on this machine or another one the user
//! sets in Settings (or one of the AI providers, which also brings its token), along with the voice
//! it speaks with and the role it plays.
//!
//! A worker thread owns the microphone and the speakers; each conversation gets a thread that holds
//! the server's WebSocket (`link.rs`), carrying Ogg Opus audio both ways (`codec.rs`, `ogg.rs`).

mod codec;
mod link;
mod ogg;

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Manager, State, Wry, plugin::TauriPlugin};
use tauri_specta::Event;

use super::{dictation, live::Live, microphone, speakers, worker::Worker};
use crate::{
    Res,
    shell::{
        popup::{self, ActionKind},
        providers, settings,
    },
};

const FEATURE: &str = "persona";
/// The command whose shortcut starts and ends a conversation.
const COMMAND: &str = "persona.talk";
const TICK: Duration = Duration::from_millis(100);
/// Where PersonaPlex's server listens by default.
pub const DEFAULT_SERVER: &str = "ws://localhost:8998";
/// The voices PersonaPlex ships: natural and varied, female and male.
pub const VOICES: &[&str] = &[
    "NATF0", "NATF1", "NATF2", "NATF3", "NATM0", "NATM1", "NATM2", "NATM3", "VARF0", "VARF1", "VARF2", "VARF3", "VARF4", "VARM0", "VARM1",
    "VARM2", "VARM3", "VARM4",
];
const DEFAULT_VOICE: &str = "NATF2";
pub const DEFAULT_PROMPT: &str =
    "You are a wise and friendly assistant. Answer questions or give advice in a clear, engaging and brief way.";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    /// Reaching the server, which then takes the voice and the persona.
    Connecting,
    /// Talking: how loud the user is (0–1), whether the voice is speaking, and its last words.
    Live {
        level: f32,
        speaking: bool,
        said: String,
    },
    Error {
        message: String,
    },
}

/// The conversation's phase, sent on every change (the level updates up to 20×/s while live).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct PhaseChanged(pub Phase);

/// `toggle` starts a conversation, or ends the one going on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Command {
    Toggle,
    Stop,
}

/// Shared between the commands, the worker and the conversation's thread.
struct Shared {
    phase: Live<Phase>,
    /// Bumped by every start and stop, so a stale conversation hangs up.
    session: AtomicU64,
}

impl Shared {
    fn publish(&self, app: &AppHandle, phase: Phase) {
        if self.phase.set(phase.clone()) {
            let _ = PhaseChanged(phase).emit(app);
        }
    }
}

/// The server and the persona the settings ask for: the server set here, or the AI provider the
/// "engine" option picks, with its token.
fn wanted(settings: &Value) -> Result<link::Target, String> {
    let text = |key, default: &str| {
        let value = settings::option(settings, FEATURE, key).and_then(Value::as_str).map_or("", str::trim);
        if value.is_empty() { default.to_string() } else { value.to_string() }
    };
    let voice = text("voice", DEFAULT_VOICE);
    let voice = if VOICES.contains(&voice.as_str()) { voice } else { DEFAULT_VOICE.to_string() };
    let persona = link::Persona { voice, prompt: text("prompt", DEFAULT_PROMPT) };
    match providers::provider(settings, FEATURE)? {
        Some(provider) => Ok(link::Target { url: link::address(&provider.base_url, &persona)?, token: provider.auth.token()? }),
        None => Ok(link::Target { url: link::address(&text("server", DEFAULT_SERVER), &persona)?, token: None }),
    }
}

/// A conversation going on: its devices, open until it ends.
struct Call {
    _mic: cpal::Stream,
    _speakers: cpal::Stream,
    /// Until the conversation's thread is done.
    running: Arc<AtomicBool>,
}

/// The worker's state: the conversation going on, if any.
#[derive(Default)]
struct Line {
    call: Option<Call>,
}

impl Line {
    fn step(&mut self, app: &AppHandle, shared: &Arc<Shared>, command: Option<Command>) {
        match command {
            Some(Command::Toggle) if self.call.is_some() => self.hang_up(app, shared),
            Some(Command::Toggle) => self.dial(app, shared),
            Some(Command::Stop) => self.hang_up(app, shared),
            // The thread ended (failed, or the server left): let the devices go.
            None => {
                if self.call.as_ref().is_some_and(|c| !c.running.load(Ordering::SeqCst)) {
                    self.call = None;
                }
            }
        }
    }

    fn dial(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        let fail = |message| shared.publish(app, Phase::Error { message });
        let current = settings::current(app);
        let target = match wanted(&current) {
            Ok(target) => target,
            Err(message) => return fail(message),
        };
        let mic = microphone::Captured::default();
        let (mic_stream, mic_rate) = match microphone::open(dictation::chosen_microphone(&current).as_deref(), Arc::clone(&mic)) {
            Ok(s) => s,
            Err(message) => return fail(message),
        };
        let queue = speakers::Queue::default();
        let (speaker_stream, speaker_rate) = match speakers::open(Arc::clone(&queue)) {
            Ok(s) => s,
            Err(message) => return fail(message),
        };
        let id = shared.session.fetch_add(1, Ordering::SeqCst) + 1;
        let running = Arc::new(AtomicBool::new(true));
        let ends = link::Ends { mic, mic_rate, speakers: queue, speaker_rate };
        let (app2, shared2, running2) = (app.clone(), Arc::clone(shared), Arc::clone(&running));
        let talk = move || {
            let current = || shared2.session.load(Ordering::SeqCst) == id;
            let result = link::run(&target, &ends, current, |phase| {
                if current() {
                    shared2.publish(&app2, phase);
                }
            });
            if current() {
                shared2.publish(&app2, result.map_or_else(|message| Phase::Error { message }, |()| Phase::Idle));
            }
            running2.store(false, Ordering::SeqCst);
        };
        if let Err(e) = std::thread::Builder::new().name("persona-link".into()).spawn(talk) {
            return fail(e.to_string());
        }
        self.call = Some(Call { _mic: mic_stream, _speakers: speaker_stream, running });
    }

    fn hang_up(&mut self, app: &AppHandle, shared: &Shared) {
        shared.session.fetch_add(1, Ordering::SeqCst);
        self.call = None;
        shared.publish(app, Phase::Idle);
    }
}

struct Persona {
    shared: Arc<Shared>,
    worker: Worker<Command>,
}

#[tauri::command]
#[specta::specta]
fn state(persona: State<'_, Persona>) -> Phase {
    persona.shared.phase.get()
}

#[tauri::command]
#[specta::specta]
fn control(persona: State<'_, Persona>, command: Command) -> Res<()> {
    persona.worker.send(command)
}

/// What a shortcut event means for the conversation: each press starts or ends one.
pub fn command_for(kind: ActionKind) -> Option<Command> {
    match kind {
        ActionKind::Press | ActionKind::Tap => Some(Command::Toggle),
        ActionKind::Release => None,
    }
}

fn on_shortcut(app: &AppHandle, action: &popup::Action) {
    if action.command != COMMAND {
        return;
    }
    if let Some(command) = command_for(action.kind)
        && let Err(e) = app.state::<Persona>().worker.send(command)
    {
        eprintln!("island: persona: {e}");
    }
}

crate::ipc::persona!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let shared = Arc::new(Shared { phase: Live::new(Phase::Idle), session: AtomicU64::new(0) });
        let (handle, stepped) = (app.clone(), Arc::clone(&shared));
        let worker = super::worker::spawn("persona", TICK, Line::default, move |line, command| line.step(&handle, &stepped, command))?;
        app.manage(Persona { shared, worker });
        let handle = app.clone();
        popup::Action::listen_any(app, move |event| on_shortcut(&handle, &event.payload));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn each_press_starts_or_ends_a_conversation() {
        assert_eq!(command_for(ActionKind::Press), Some(Command::Toggle));
        assert_eq!(command_for(ActionKind::Tap), Some(Command::Toggle));
        assert_eq!(command_for(ActionKind::Release), None);
    }

    #[test]
    fn talks_to_the_server_and_persona_set() {
        let with = |options: Value| wanted(&json!({ "options": { "persona": options } }));
        let set = with(json!({ "server": "wss://gpu.lan:8998", "voice": "VARM3", "prompt": "Be brief." })).unwrap();
        assert_eq!(set.url, "wss://gpu.lan:8998/api/chat?voice_prompt=VARM3.pt&text_prompt=Be%20brief.");
        assert_eq!(set.token, None);
        let defaults = with(json!({ "server": " ", "voice": "nobody", "prompt": "" })).unwrap();
        assert!(defaults.url.starts_with("ws://localhost:8998/api/chat?voice_prompt=NATF2.pt&text_prompt=You%20are%20a%20wise"));
        assert_eq!(wanted(&json!({})).unwrap(), defaults);
        assert!(with(json!({ "server": "ftp://x" })).is_err());
    }

    #[test]
    fn talks_to_the_ai_provider_chosen_with_its_token() {
        let settings = |engine: &str| {
            json!({
                "providers": [
                    { "id": "gpu", "name": "GPU box", "baseUrl": "https://gpu.example.com/", "auth": { "kind": "env", "name": "AIN_TEST_PERSONAPLEX_TOKEN" } },
                    { "id": "lab", "name": "Lab", "baseUrl": "http://10.0.0.2:8998" }
                ],
                "options": { "persona": { "engine": engine, "server": "ws://ignored:1", "voice": "NATM1", "prompt": "Hi" } }
            })
        };
        let lab = wanted(&settings("lab")).unwrap();
        assert_eq!((lab.url.as_str(), lab.token), ("ws://10.0.0.2:8998/api/chat?voice_prompt=NATM1.pt&text_prompt=Hi", None));
        // SAFETY: no other test reads or writes this variable.
        unsafe { std::env::remove_var("AIN_TEST_PERSONAPLEX_TOKEN") };
        assert!(
            wanted(&settings("gpu")).unwrap_err().contains("AIN_TEST_PERSONAPLEX_TOKEN"),
            "a missing token says where it was looked for"
        );
        unsafe { std::env::set_var("AIN_TEST_PERSONAPLEX_TOKEN", "abc") };
        let gpu = wanted(&settings("gpu")).unwrap();
        assert_eq!(
            (gpu.url.as_str(), gpu.token.as_deref()),
            ("wss://gpu.example.com/api/chat?voice_prompt=NATM1.pt&text_prompt=Hi", Some("abc"))
        );
        assert!(wanted(&settings("gone")).unwrap_err().contains("is gone"));
    }

    #[test]
    fn phases_serialize_for_the_page() {
        let live = serde_json::to_value(Phase::Live { level: 0.5, speaking: true, said: "Hi".into() }).unwrap();
        assert_eq!(live, json!({ "phase": "live", "level": 0.5, "speaking": true, "said": "Hi" }));
        assert_eq!(serde_json::to_value(Phase::Connecting).unwrap(), json!({ "phase": "connecting" }));
    }
}
