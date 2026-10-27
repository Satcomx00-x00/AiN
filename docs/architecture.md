# Architecture

AiN is a Tauri app: a Rust backend talks to the OS, and a TypeScript frontend draws the island
and its windows. Both sides are split the same way:

| | Frontend (`ain/src`) | Backend (`ain/src-tauri/src`) |
| --- | --- | --- |
| **shell**: the app itself | `shell/`: island host, layout, settings, shortcuts, the windows' entry points | `shell/`: island window, popup and capture overlay, settings file, tray, plugins folder |
| **features**: what the island shows | `features/<id>/`: one folder each, with its generated `bindings.ts` | `features/<id>`: one module each, with one backend per OS |
| **sdk**: the plugin API | `sdk/`: `definePlugin`, options, DOM and chart helpers | none |

The shell knows no feature: it hosts whatever plugins it is given. Features build on the SDK and on
their own backend.

## The contract between the two sides

[`src-tauri/src/manifest.rs`](../ain/src-tauri/src/manifest.rs) lists every command and
event once. From it:

- `build.rs` generates each plugin's permissions (`<plugin>:allow-<command>`, and a `default` set);
- each module registers its handlers with `crate::ipc::<plugin>!()`;
- `cargo test` regenerates the TypeScript bindings next to the frontend code
  (`src/features/<id>/bindings.ts`, `src/shell/bindings/<plugin>.ts`) with
  [tauri-specta](https://github.com/specta-rs/tauri-specta).

A command listed but not written fails to compile; one written but not listed is dead code, which
`clippy -D warnings` rejects; stale bindings fail CI. Commands that move raw bytes (screen captures,
images) can't be described by bindings: they're listed as `raw` and called by name, and a Rust test
checks that every name the frontend uses exists.

The frontend wraps each feature's bindings in a small *port* (`features/<id>/service.ts`), the
interface the feature's UI uses. Previews and tests swap in fakes of just that port.

## Platform backends

A feature that reads the OS keeps its OS code beside it, behind a small trait:

```text
features/volume/
  mod.rs      types, commands, the Backend trait, and the worker loop (all platforms)
  mixer.rs    logic every backend shares
  windows.rs  Core Audio
  linux.rs    PipeWire/PulseAudio, through pactl
```

`open()` picks the backend for the platform it was built for, or returns `None` where there is
none: the feature then reports "unsupported" (or nothing) instead of failing. The worker loop
(`Shared::poll`) is plain code tested against a fake backend, so recovering when a device
disappears is tested on every platform.

| Feature | Windows | Linux | macOS |
| --- | --- | --- | --- |
| media | Media transport controls | MPRIS (D-Bus) | Spotify and Music, scripted through `osascript` |
| volume | Core Audio | PipeWire/PulseAudio (`pactl`) | Core Audio (output devices; macOS has no per-app volume) |
| privacy | Capability Access Manager | recording streams (`pactl`) and open `/dev/video*` | Core Audio's process list (macOS 14+) and Core Media IO (camera on or off) |
| dictation | types the text | pastes it (Ctrl+V through the Remote Desktop portal, `xdotool`, `wtype` or `ydotool`), or types it when asked, else copies it | types it once Accessibility is allowed, else copies it |
| transcript | records the default output in loopback (WASAPI, through cpal) | records the default sink's monitor with `parec` | records the default output through a Core Audio process tap (cpal, macOS 14.6+) |
| tts (read aloud) | copies the selection (Ctrl+C), then puts the clipboard back | reads the primary selection | copies the selection (Cmd+C) once Accessibility is allowed, then puts the clipboard back |
| popup paste | `SendInput` | the same tools | Cmd+V, once Accessibility is allowed |
| clipboard, stats, capture | all platforms | | |

Helpers several backends share live in `platform/`: `pactl` and the key tools on Linux, Core Audio's
property API and synthetic keys on macOS. macOS permission prompts are explained by the strings in
`src-tauri/Info.plist`.

## AI providers

Settings → AI providers lists online services (OpenAI, Groq, Mistral) and the user's own
OpenAI-compatible servers (a gateway, vLLM, LocalAI…), kept in the settings' `providers`.
Each has a base URL and an authentication: none, or a bearer token (an API key or a JWT) read from
an environment variable or a file, read again on every request so a rotated token is picked up; an
expired JWT is refused before it is sent. Tokens never enter `settings.json`, only where to find them.

Every AI feature then picks its engine in its card: its own model on this computer (the default),
or a provider and that provider's model (and voice). The backend's `shell::providers` reads the
choice (`chosen(settings, feature)`) and speaks the provider's API (`/audio/transcriptions`,
`/audio/speech` in WAV, `/models` for Settings' "Test connection"); dictation sends each 30 s chunk,
read aloud a few sentences at a time. Transcript runs on dictation's speech model (`dictation::speech_models`), or its own provider choice, and sends 8 s chunks, skipping silent ones. A new AI feature adds `engineOptions()` to its options, draws
`enginePanel` in its settings panel and matches on `providers::Engine` in its backend.

## Adding a feature

1. **Backend** (if it needs one): add `src-tauri/src/features/<id>.rs` (or a folder), register it in
   `features/mod.rs`, and list its commands and events in `manifest.rs`. Derive `serde` and
   `specta::Type` on what crosses the boundary, annotate commands with `#[tauri::command]` and
   `#[specta::specta]`, and end the module with `crate::ipc::<id>!();` before `init()`.
   OS-specific code goes behind a trait, as above.
2. Run `cargo test`: it writes `src/features/<id>/bindings.ts`.
3. **Permissions**: add `<id>:default` to the capabilities of the windows that use it
   (`src-tauri/capabilities/`).
4. **Frontend**: `src/features/<id>/service.ts` (the port over the bindings), `index.ts`
   (`definePlugin`), then add it to `features/services.ts`, the catalogue in `features/index.ts`,
   and, if it should show by default, `features/layout.ts`.
5. Tests: logic in plain functions next to the code (Rust `#[cfg(test)]`, TS `*.test.ts`).

## Plugins from the plugins folder

Third-party plugins are JavaScript files in the app's `plugins` folder, written against the SDK;
see [writing a plugin](plugins.md). The shell's `extensions` module finds them; the frontend's
`shell/extensions.ts` loads, checks and confines them:

- a file's code never runs until the user turns it on in Settings (they are tracked by file name,
  since a plugin's id is only known by running it);
- a plugin receives only the services it lists in `needs`, among those the app offers
  (`extensionRules` in `features/index.ts`; not clipboard history, screen captures, dictation or read aloud);
- each part of its widget is switched off the first time it throws, instead of breaking the island;
- it can't take a built-in feature's id, nor define shortcut commands.

It still runs in the island's page, with its permissions: the Settings page says so.

## Updates

The shell's `updater` module checks the release host for a newer version and, when the user asks,
installs it and restarts, on every platform; see [updates](updates.md).
