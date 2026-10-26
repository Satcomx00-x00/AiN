//! Conversation: talk with NVIDIA PersonaPlex, a full-duplex speech-to-speech model, as with a
//! person. It listens while it speaks, so the user can interrupt it, and it backchannels. The model
//! (7B, a GPU with 24 GB) runs on this computer, where the app installs and runs PersonaPlex's
//! server (`local.rs`), or on a server one of the AI providers points to, with its token. Settings
//! also pick the voice it speaks with and the role it plays.
//!
//! A worker thread owns the microphone and the speakers; each conversation gets a thread that holds
//! the server's WebSocket (`link.rs`), carrying Ogg Opus audio both ways (`codec.rs`, `ogg.rs`).

mod codec;
mod link;
mod local;
mod ogg;

use std::{
    path::{Path, PathBuf},
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

use self::local::{Launch, Local, LocalInfo, Place};
use super::{dictation, download, live::Live, lock, microphone, speakers, worker::Worker};
use crate::{
    Res, platform,
    shell::{
        popup::{self, ActionKind},
        providers, secrets,
        settings::{self, SettingsChanged},
    },
};

const FEATURE: &str = "persona";
/// The command whose shortcut starts and ends a conversation.
const COMMAND: &str = "persona.talk";
const TICK: Duration = Duration::from_millis(100);
/// How long the server on this computer stays up, its model loaded, once no conversation uses it.
const IDLE: Duration = Duration::from_secs(10 * 60);
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
    /// Starting PersonaPlex on this computer (the first time, downloading its weights): its last
    /// line of output.
    Starting {
        line: String,
    },
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

/// PersonaPlex on this computer was installed or removed, its weights downloaded, or its server
/// started or stopped.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct LocalChanged(pub LocalInfo);

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
    local: Arc<Local>,
    /// The models folder, unless the settings pick another.
    models: PathBuf,
}

impl Shared {
    fn publish(&self, app: &AppHandle, phase: Phase) {
        if self.phase.set(phase.clone()) {
            let _ = PhaseChanged(phase).emit(app);
        }
    }
}

/// PersonaPlex's folder on this computer: in the models folder the settings pick.
fn place(settings: &Value, models: &Path) -> Place {
    let chosen = settings::option(settings, FEATURE, "modelDir").and_then(Value::as_str);
    Place(download::base_in(chosen, models).join("personaplex"))
}

/// Where a conversation goes.
#[derive(Debug, PartialEq)]
enum Endpoint {
    /// The server the app runs on this computer.
    ThisComputer { cpu_offload: bool },
    /// The AI provider's server, with its token.
    Provider(link::Target),
}

/// The persona and the server the settings ask for: this computer, or the AI provider the "engine"
/// option picks.
fn wanted(settings: &Value) -> Result<(link::Persona, Endpoint), String> {
    let text = |key, default: &str| {
        let value = settings::option(settings, FEATURE, key).and_then(Value::as_str).map_or("", str::trim);
        if value.is_empty() { default.to_string() } else { value.to_string() }
    };
    let voice = text("voice", DEFAULT_VOICE);
    let voice = if VOICES.contains(&voice.as_str()) { voice } else { DEFAULT_VOICE.to_string() };
    let persona = link::Persona { voice, prompt: text("prompt", DEFAULT_PROMPT) };
    let endpoint = match providers::provider(settings, FEATURE)? {
        Some(provider) => {
            Endpoint::Provider(link::Target { url: link::address(&provider.base_url, &persona)?, token: provider.auth.token()? })
        }
        None => Endpoint::ThisComputer {
            cpu_offload: settings::option(settings, FEATURE, "cpuOffload").and_then(Value::as_bool).unwrap_or(false),
        },
    };
    Ok((persona, endpoint))
}

/// The server to talk to: the provider's, or the one on this computer once started.
fn reach(
    shared: &Shared,
    place: &Place,
    persona: &link::Persona,
    endpoint: Endpoint,
    go_on: &dyn Fn() -> bool,
    report: &mut dyn FnMut(Phase),
) -> Result<link::Target, String> {
    let cpu_offload = match endpoint {
        Endpoint::Provider(target) => return Ok(target),
        Endpoint::ThisComputer { cpu_offload } => cpu_offload,
    };
    report(Phase::Starting { line: String::new() });
    // The weights are gated: Hugging Face wants the token of a user who accepted their license.
    let token = secrets::secret(FEATURE, "hfToken").ok().flatten();
    let port =
        shared.local.serve(place, &Launch { token, cpu_offload }, go_on, &mut |line| report(Phase::Starting { line: line.into() }))?;
    Ok(link::Target { url: link::address(&format!("ws://127.0.0.1:{port}"), persona)?, token: None })
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
                if self.call.is_some() { shared.local.touch() } else { shared.local.let_cold_go(IDLE) }
            }
        }
    }

    fn dial(&mut self, app: &AppHandle, shared: &Arc<Shared>) {
        let fail = |message| shared.publish(app, Phase::Error { message });
        let current = settings::current(app);
        let (persona, endpoint) = match wanted(&current) {
            Ok(wanted) => wanted,
            Err(message) => return fail(message),
        };
        let place = place(&current, &shared.models);
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
            let mut report = |phase| {
                // No one to hear yet while the server starts: what the microphone took is dropped.
                if matches!(phase, Phase::Starting { .. }) {
                    lock(&ends.mic).clear();
                }
                if current() {
                    shared2.publish(&app2, phase);
                }
            };
            let result = reach(&shared2, &place, &persona, endpoint, &current, &mut report)
                .and_then(|target| link::run(&target, &ends, current, report));
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

impl Persona {
    fn place(&self, app: &AppHandle) -> Place {
        place(&settings::current(app), &self.shared.models)
    }
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

/// PersonaPlex on this computer: its folder, whether it is installed, and whether it runs.
#[tauri::command]
#[specta::specta]
fn local_status(app: AppHandle, persona: State<'_, Persona>) -> LocalInfo {
    persona.shared.local.info(&persona.place(&app))
}

/// Installs PersonaPlex on this computer, in the background.
#[tauri::command]
#[specta::specta]
fn install_local(app: AppHandle, persona: State<'_, Persona>) -> Res<()> {
    Ok(persona.shared.local.install(persona.place(&app))?)
}

/// Downloads PersonaPlex's weights on this computer, in the background, with the user's Hugging Face
/// token (they are gated).
#[tauri::command]
#[specta::specta]
fn download_model(app: AppHandle, persona: State<'_, Persona>) -> Res<()> {
    let token = secrets::secret(FEATURE, "hfToken").ok().flatten();
    Ok(persona.shared.local.download(persona.place(&app), token)?)
}

/// Stops a download of the weights; the next one resumes it.
#[tauri::command]
#[specta::specta]
fn cancel_download(persona: State<'_, Persona>) {
    persona.shared.local.cancel_download();
}

/// Stops an install, a download or the server, and deletes PersonaPlex and its weights from this computer.
#[tauri::command]
#[specta::specta]
async fn remove_local(app: AppHandle, persona: State<'_, Persona>) -> Res<()> {
    let (local, place) = (Arc::clone(&persona.shared.local), persona.place(&app));
    tauri::async_runtime::spawn_blocking(move || local.remove(&place)).await.map_err(|_| crate::Error::WorkerGone)??;
    Ok(())
}

/// Shows PersonaPlex's folder.
#[tauri::command]
#[specta::specta]
fn open_local_dir(app: AppHandle, persona: State<'_, Persona>) -> Res<()> {
    let dir = persona.place(&app).0;
    std::fs::create_dir_all(&dir)?;
    Ok(platform::reveal(&dir)?)
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
    ipc()
        .builder(|app| {
            let models = app.path().app_data_dir()?.join("models");
            let handle = app.clone();
            let wheel = app.path().resource_dir()?.join("personaplex").join(local::WHEEL);
            let local =
                Arc::new(Local::new(&place(&settings::current(app), &models), wheel, move |info| drop(LocalChanged(info).emit(&handle))));
            let shared = Arc::new(Shared { phase: Live::new(Phase::Idle), session: AtomicU64::new(0), local, models });
            let (handle, stepped) = (app.clone(), Arc::clone(&shared));
            let worker = super::worker::spawn("persona", TICK, Line::default, move |line, command| line.step(&handle, &stepped, command))?;
            app.manage(Persona { shared, worker });
            let handle = app.clone();
            popup::Action::listen_any(app, move |event| on_shortcut(&handle, &event.payload));
            // Another models folder: what Settings shows follows it.
            let handle = app.clone();
            SettingsChanged::listen_any(app, move |_| {
                let persona = handle.state::<Persona>();
                drop(LocalChanged(persona.shared.local.info(&persona.place(&handle))).emit(&handle));
            });
            Ok(())
        })
        // The server holds the GPU: it goes with the app.
        .on_event(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Persona>().shared.local.stop();
            }
        })
        .build()
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
    fn talks_to_this_computer_with_the_persona_set() {
        let with = |options: Value| wanted(&json!({ "options": { "persona": options } })).unwrap();
        let (persona, endpoint) = with(json!({ "voice": "VARM3", "prompt": "Be brief.", "cpuOffload": true }));
        assert_eq!((persona.voice.as_str(), persona.prompt.as_str()), ("VARM3", "Be brief."));
        assert_eq!(endpoint, Endpoint::ThisComputer { cpu_offload: true });
        let (persona, endpoint) = with(json!({ "voice": "nobody", "prompt": " " }));
        assert_eq!((persona.voice.as_str(), persona.prompt.as_str()), (DEFAULT_VOICE, DEFAULT_PROMPT));
        assert_eq!(endpoint, Endpoint::ThisComputer { cpu_offload: false });
        assert_eq!(wanted(&json!({})).unwrap().1, endpoint);
    }

    #[test]
    fn keeps_personaplex_in_the_models_folder_chosen() {
        let models = Path::new("/data/models");
        assert_eq!(place(&json!({}), models).0, models.join("personaplex"));
        let elsewhere = std::env::temp_dir();
        let settings = json!({ "options": { "persona": { "modelDir": elsewhere.to_str() } } });
        assert_eq!(place(&settings, models).0, elsewhere.join("personaplex"));
    }

    #[test]
    fn talks_to_the_ai_provider_chosen_with_its_token() {
        let settings = |engine: &str| {
            json!({
                "providers": [
                    { "id": "gpu", "name": "GPU box", "baseUrl": "https://gpu.example.com/", "auth": { "kind": "env", "name": "AIN_TEST_PERSONAPLEX_TOKEN" } },
                    { "id": "lab", "name": "Lab", "baseUrl": "http://10.0.0.2:8998" }
                ],
                "options": { "persona": { "engine": engine, "voice": "NATM1", "prompt": "Hi" } }
            })
        };
        let target = |engine| match wanted(&settings(engine)).map(|w| w.1) {
            Ok(Endpoint::Provider(target)) => Ok(target),
            Ok(other) => panic!("{other:?}"),
            Err(e) => Err(e),
        };
        let lab = target("lab").unwrap();
        assert_eq!((lab.url.as_str(), lab.token), ("ws://10.0.0.2:8998/api/chat?voice_prompt=NATM1.pt&text_prompt=Hi", None));
        // SAFETY: no other test reads or writes this variable.
        unsafe { std::env::remove_var("AIN_TEST_PERSONAPLEX_TOKEN") };
        assert!(target("gpu").unwrap_err().contains("AIN_TEST_PERSONAPLEX_TOKEN"), "a missing token says where it was looked for");
        unsafe { std::env::set_var("AIN_TEST_PERSONAPLEX_TOKEN", "abc") };
        let gpu = target("gpu").unwrap();
        assert_eq!(
            (gpu.url.as_str(), gpu.token.as_deref()),
            ("wss://gpu.example.com/api/chat?voice_prompt=NATM1.pt&text_prompt=Hi", Some("abc"))
        );
        assert!(target("gone").unwrap_err().contains("is gone"));
    }

    #[test]
    fn phases_serialize_for_the_page() {
        let live = serde_json::to_value(Phase::Live { level: 0.5, speaking: true, said: "Hi".into() }).unwrap();
        assert_eq!(live, json!({ "phase": "live", "level": 0.5, "speaking": true, "said": "Hi" }));
        assert_eq!(serde_json::to_value(Phase::Connecting).unwrap(), json!({ "phase": "connecting" }));
        let starting = Phase::Starting { line: "Fetching 4 files".into() };
        assert_eq!(serde_json::to_value(starting).unwrap(), json!({ "phase": "starting", "line": "Fetching 4 files" }));
    }
}
