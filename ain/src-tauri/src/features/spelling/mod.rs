//! Spelling: select text anywhere, press a shortcut, and its mistakes are corrected in place, in
//! French or English. On this machine, Hunspell dictionaries (read by spellbook, in Rust) fix the
//! misspelled words one by one; nothing leaves the computer. They are downloaded once, when the
//! user asks (`dictionaries.rs`). Or, when the user picks one of their AI providers instead
//! (`shell::providers`), its chat model corrects spelling and grammar alike.
//!
//! A worker thread runs each correction, one at a time: the selection comes from
//! `features/selection.rs`, the corrected text is typed over it (`features/delivery`).

mod dictionaries;
mod engine;
mod speller;

use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State, Wry, async_runtime::spawn_blocking, plugin::TauriPlugin};
use tauri_specta::Event;

use super::{
    delivery::Delivery,
    live::Live,
    models::{ModelInfo, ModelStore},
    worker::Worker,
};
use crate::{
    Error, Res,
    shell::{
        popup::{self, ActionKind},
        providers,
        settings::{self, SettingsChanged},
    },
};

const FEATURE: &str = "spelling";
/// The command whose shortcut corrects the selection.
const COMMAND: &str = "spelling.fix";
/// How often the worker looks for dictionaries gone cold.
const TICK: Duration = Duration::from_secs(1);
/// The dictionaries take some tens of MB of memory; they are let go after this long unused.
const KEEP_WARM: Duration = Duration::from_secs(10 * 60);
/// A selection, not a book: suggestions take a while for each misspelled word.
const MAX_CHARS: usize = 20_000;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    /// The shortcut fired but the dictionaries aren't downloaded.
    NeedsModel,
    /// The shortcut fired but no text is selected (or it couldn't be read).
    NothingSelected,
    Checking,
    Done {
        original: String,
        corrected: String,
        /// How many words changed; none when the text was right.
        fixes: u32,
        /// How the correction was handed over; none when there was nothing to correct.
        delivery: Option<Delivery>,
    },
    Error {
        message: String,
    },
}

/// The correction's phase, sent on every change.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct PhaseChanged(pub Phase);

/// The dictionaries' status, sent as it changes (and as they download).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct ModelChanged(pub ModelInfo);

/// A text after correction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Correction {
    pub text: String,
    /// How many words changed.
    pub fixes: u32,
}

/// What the worker is asked.
enum Request {
    /// Correct the selection.
    Fix,
}

/// Shared between the commands and the worker.
struct Shared {
    phase: Live<Phase>,
    models: Arc<ModelStore<dictionaries::Dictionaries, speller::Speller<spellbook::Dictionary>>>,
}

impl Shared {
    fn publish(&self, app: &AppHandle, phase: Phase) {
        if self.phase.set(phase.clone()) {
            let _ = PhaseChanged(phase).emit(app);
        }
    }
}

struct Spelling {
    shared: Arc<Shared>,
    worker: Worker<Request>,
}

#[tauri::command]
#[specta::specta]
fn state(spelling: State<'_, Spelling>) -> Phase {
    spelling.shared.phase.get()
}

#[tauri::command]
#[specta::specta]
fn model_status(spelling: State<'_, Spelling>) -> ModelInfo {
    spelling.shared.models.info()
}

/// Shows the dictionaries' folder (or the nearest one that exists) in the file manager.
#[tauri::command]
#[specta::specta]
async fn open_model_dir(spelling: State<'_, Spelling>) -> Res<()> {
    crate::platform::reveal(&spelling.shared.models.existing_dir())?;
    Ok(())
}

/// Corrects the selected text, as the shortcut does.
#[tauri::command]
#[specta::specta]
fn fix(spelling: State<'_, Spelling>) -> Res<()> {
    spelling.worker.send(Request::Fix)
}

/// `text` corrected by the chosen engine, without touching the selection: to try it in Settings.
#[tauri::command]
#[specta::specta]
async fn check(app: AppHandle, spelling: State<'_, Spelling>, text: String) -> Res<Correction> {
    let shared = Arc::clone(&spelling.shared);
    let settings = settings::current(&app);
    spawn_blocking(move || {
        let engine = providers::chosen(&settings, FEATURE)?;
        engine::correct(&shared, &engine, &text, engine::Preferences::read(&settings).language)
    })
    .await
    .map_err(|_| Error::WorkerGone)?
    .map_err(Error::msg)
}

/// Starts downloading the dictionaries in the background; progress arrives as `ModelChanged` events.
#[tauri::command]
#[specta::specta]
fn download_model(app: AppHandle, spelling: State<'_, Spelling>) -> Res<()> {
    spelling.shared.models.download(app)?;
    Ok(())
}

/// Stops a download in progress, or deletes the downloaded dictionaries.
#[tauri::command]
#[specta::specta]
fn delete_model(app: AppHandle, spelling: State<'_, Spelling>) -> Res<()> {
    spelling.shared.models.remove(&app)?;
    Ok(())
}

/// Whether a shortcut event corrects the selection: each press does.
pub fn fixes_on(kind: ActionKind) -> bool {
    matches!(kind, ActionKind::Press | ActionKind::Tap)
}

fn on_shortcut(app: &AppHandle, action: &popup::Action) {
    if action.command == COMMAND
        && fixes_on(action.kind)
        && let Err(e) = app.state::<Spelling>().worker.send(Request::Fix)
    {
        eprintln!("island: spelling: {e}");
    }
}

fn spawn(app: AppHandle, shared: Arc<Shared>) -> std::io::Result<Worker<Request>> {
    super::worker::spawn(
        "spelling",
        TICK,
        || (),
        move |(), request| match request {
            Some(Request::Fix) => {
                let phase = engine::fix(&app, &shared, super::selection::raw);
                shared.publish(&app, phase);
            }
            None => shared.models.let_cold_go(KEEP_WARM),
        },
    )
}

crate::ipc::spelling!();

pub fn init() -> TauriPlugin<Wry> {
    ipc().plugin(|app| {
        let default_dir = app.path().app_data_dir()?.join("models");
        let emit = |app: &AppHandle, info| drop(ModelChanged(info).emit(app));
        let models =
            Arc::new(ModelStore::new(FEATURE, dictionaries::MODELS, &settings::current(app), default_dir, emit, dictionaries::load));
        let shared = Arc::new(Shared { phase: Live::new(Phase::Idle), models });
        let worker = spawn(app.clone(), Arc::clone(&shared))?;
        let (handle, followed) = (app.clone(), Arc::clone(&shared));
        SettingsChanged::listen_any(app, move |event| followed.models.follow_settings(&handle, &event.payload.0.0));
        app.manage(Spelling { shared, worker });
        let handle = app.clone();
        popup::Action::listen_any(app, move |event| on_shortcut(&handle, &event.payload));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_press_corrects() {
        assert!(fixes_on(ActionKind::Press) && fixes_on(ActionKind::Tap));
        assert!(!fixes_on(ActionKind::Release));
    }

    #[test]
    fn phases_serialize_for_the_page() {
        let done = Phase::Done { original: "teh".into(), corrected: "the".into(), fixes: 1, delivery: Some(Delivery::Typed) };
        assert_eq!(
            serde_json::to_value(done).unwrap(),
            serde_json::json!({ "phase": "done", "original": "teh", "corrected": "the", "fixes": 1, "delivery": "typed" })
        );
        assert_eq!(serde_json::to_value(Phase::NothingSelected).unwrap(), serde_json::json!({ "phase": "nothingSelected" }));
    }
}
