// Every IPC command and event the app has, listed once. `build.rs` includes this file to generate
// each plugin's permissions; `ipc.rs` expands it into the plugins' handlers and their TypeScript
// bindings. So adding a command here is all it takes, and nothing can drift.
//
// Each entry is `<plugin name>: <module> { typed, raw, events }`:
// - `typed` commands get generated bindings (`bindings.ts` beside the feature's frontend code);
// - `raw` commands move binary bodies (`tauri::ipc::Request`/`Response`), which bindings can't
//   describe, so the frontend calls them by hand;
// - `events` are typed events the module emits (types deriving `tauri_specta::Event`).
//
// The shell is the app itself (the island window, shortcuts, settings…); features are what the
// island shows, each its own plugin.

macro_rules! manifest {
    ($then:ident) => {
        $then! {
            shell {
                island: shell::island { typed: [info, layout, auto_hide, screens], raw: [], events: [Revealed, ScreensChanged] }
                popup: shell::popup {
                    typed: [bind, failures, open, hide, paste],
                    raw: [],
                    events: [Shown, BindingsChanged, Action]
                }
                settings: shell::settings { typed: [get, set, open, quit, autostart, set_autostart, play_greeting], raw: [], events: [SettingsChanged, Navigate, PlayGreeting] }
                capture: shell::capture { typed: [], raw: [latest, save_png], events: [] }
                extensions: shell::extensions { typed: [list, open_dir], raw: [], events: [] }
                store: shell::store { typed: [catalog, install, open_repo], raw: [], events: [] }
                secrets: shell::secrets { typed: [get, set, saved_keys], raw: [], events: [SecretChanged] }
                oauth: shell::oauth { typed: [sign_in, token, sign_out, signed_in], raw: [], events: [] }
                providers: shell::providers { typed: [models, preset_urls], raw: [], events: [] }
                updates: shell::updater { typed: [status, check, install, open_releases], raw: [], events: [UpdateChanged] }
            }
            features {
                clipboard: features::clipboard { typed: [history, copy, clear], raw: [copy_image], events: [] }
                dictation: features::dictation {
                    typed: [state, model_status, microphones, control, download_model, delete_model, open_model_dir],
                    raw: [],
                    events: [PhaseChanged, ModelChanged]
                }
                media: features::media { typed: [state, artwork, control], raw: [], events: [TrackChanged] }
                palette: features::palette { typed: [apps, launch, files, browse, open, reveal, run, system, open_url], raw: [], events: [] }
                persona: features::persona { typed: [state, control, local_status, install_local, download_model, cancel_download, test_local, stop_test, remove_local, open_local_dir], raw: [], events: [PhaseChanged, LocalChanged, TestProgress] }
                privacy: features::privacy { typed: [state], raw: [], events: [UsageChanged] }
                spelling: features::spelling {
                    typed: [state, model_status, fix, check, download_model, delete_model, open_model_dir],
                    raw: [],
                    events: [PhaseChanged, ModelChanged]
                }
                stats: features::stats { typed: [latest], raw: [], events: [] }
                transcript: features::transcript { typed: [state, lines, control], raw: [], events: [PhaseChanged, LinesChanged] }
                tts: features::tts {
                    typed: [state, model_status, control, speak, download_model, delete_model, open_model_dir],
                    raw: [],
                    events: [PhaseChanged, ModelChanged]
                }
                volume: features::volume {
                    typed: [state, peak, sources, set_level, set_muted],
                    raw: [],
                    events: [OutputChanged, SourcesChanged]
                }
                zones: features::zones { typed: [support, install_helper, layout, overlay_state, snap, screen, cancel], raw: [], events: [OverlayChanged] }
            }
        }
    };
}
