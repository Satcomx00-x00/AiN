# Testing

How AiN is tested, what each layer proves, and on which systems. Everything here runs in CI
(`.github/workflows/ci.yml`) on every pull request and every push to `main`.

## The layers

```
                 ┌───────────────────────────┐
                 │ Install & launch, per OS  │  the packaged app, installed, started for real
               ┌─┴───────────────────────────┴─┐
               │ Browser: e2e and smoke, per OS │  real engines, real layout, the built app
             ┌─┴───────────────────────────────┴─┐
             │ Integration (vitest)               │  the whole island against a fake system
           ┌─┴───────────────────────────────────┴─┐
           │ Unit: TypeScript (vitest), Rust (cargo) │  every module, every OS's backend
           └─────────────────────────────────────────┘
```

| Layer | Tool | Where | What it proves |
| --- | --- | --- | --- |
| Unit, frontend | vitest + happy-dom | `ain/src/**/*.test.ts` | Each plugin, port, SDK helper and window: rendering, options, settings, shortcuts, error paths |
| Integration, frontend | vitest | `ain/src/integration/` | The island and Settings run for real against `harness.ts`: a fake system that pushes data, records calls, and moves a fake clock |
| Unit, backend | `cargo test` | `#[cfg(test)]` in `ain/src-tauri/src/**` | Each feature's logic, its OS backend on the OS that has it, IPC manifest and permissions, generated bindings up to date |
| Integration, backend | `cargo test` | `ain/src-tauri/tests/` | The update flow (check, download, signature) on Tauri's mock runtime |
| End to end | Playwright | `ain/e2e/` | The island, popups and Settings in Chromium (WebView2's engine) and WebKit (WebKitGTK's), on the preview's fake backend |
| Smoke | Playwright | `ain/smoke/` | The production build, each window opened with a stand-in for the Tauri backend |
| Install & launch | shell, PowerShell | `.github/scripts/launch-check*` | The packaged app installs, starts, shows its window and keeps running without a crash |
| Release checks | Python | `.github/scripts/test-check-update-manifest.sh` | The update manifest a release publishes |

## Systems

All x64 (64-bit).

| System | Runner | Unit & integration | Browser | Install & launch |
| --- | --- | --- | --- | --- |
| **Windows 11** | `windows-2025` | Rust (MSVC), with coverage | Chromium, WebKit | NSIS installer, silent, per user; the installed `AiN.exe` launched, its window found; uninstalled |
| **Linux (Ubuntu 24.04)** | `ubuntu-24.04` | TypeScript (with the coverage gate), Rust, with coverage | Chromium, WebKit | AppImage on Xvfb: the island's window must reach its laid-out size |
| **Fedora 43, 44** | `fedora:43`, `fedora:44` containers | TypeScript, Rust, against Fedora's own GTK, WebKitGTK and PipeWire | — | `.rpm` built, installed with `dnf`, the installed binary launched on Xvfb |

GitHub offers no hosted Windows 11 x64 runner. Windows Server 2025 is built from the same release
as Windows 11 24H2 (build 26100): the same kernel, Win32, WinRT media controls, Core Audio,
Capability Access Manager and WebView2 the backends use. To run on a real Windows 11 machine as
well, register it as a self-hosted runner and add it to the matrices.

## Coverage

| Code | Target | How it's enforced |
| --- | --- | --- |
| Frontend (`ain/src`) | **100%** statements, branches, functions and lines | `vitest.config.ts` thresholds; `bun run test:coverage` fails the Frontend job below them |
| Backend (`ain/src-tauri`) | Lines: **52%** Linux, **48%** Windows, at least | `cargo llvm-cov` on each OS fails the Rust job below its floor (`min_lines` in `ci.yml`), with a summary in the job's page and `lcov.info` as an artifact |

Left out of the frontend's figure, on purpose: the generated IPC bindings (`bindings.ts`, checked
by `cargo test` instead), the dev-only preview page, and the integration harness, which is test code.

The floors sit about 2 points under what each OS measured when they were set (53.97%, 50.10%): raise them as tests are added, never lower them to get green. The backend can't be held to
one figure: each OS compiles only its own backends (`windows.rs`,
`linux.rs`), so every line is covered on the OS it runs on, and the two reports
together cover the code. What a CI machine can't do is tested by hand: the hardware smoke tests,
marked `#[ignore]`, list this machine's microphones and download the voice archives:

```sh
cd ain/src-tauri
cargo test -- --ignored --nocapture
```

## What each part covers

| Area | Cases |
| --- | --- |
| Plugins (`features/`) | Glance text per state; panel rendering; every option; settings panels (choices, downloads, folders); the commands' shortcuts and surfaces; error and empty states |
| Ports (`features/*/service.ts`, `shell/*.ts`) | Each command's Rust name and payload; event payloads mapped; a failed first read stops listening |
| Dictation, read aloud | Model choice and download, stop and remove; voices per model; shortcut press and hold; phases on the pill; the backends' model store (choice, folder, warm engine), archive unpacking, speed and voice bounds |
| Settings | Every section and control; saving; validation; shortcuts recording; plugins folder and community store; secrets never read back |
| OS backends (Rust) | Key synthesis and clipboard on each OS; `pactl` parsing on Linux; media, volume and privacy watchers; Windows exe names |
| Security | IPC permissions generated per command; secrets in the system's store; plugins sandboxed to the services they list; update signatures checked |

## Running the tests

```sh
cd ain
bun run test            # unit and integration
bun run test:coverage   # the same, failing below 100%
bun run test:e2e        # Playwright: Chromium and WebKit
bun run test:smoke      # the production build in Playwright
cd src-tauri
cargo test              # backend, this OS's backends
cargo llvm-cov --open   # backend coverage, in the browser (needs cargo-llvm-cov)
```

## Writing tests

- Name tests after behavior: "reads the last text again, or stops a reading".
- Test plugins through their ports with fakes (see `features/tts/tts.test.ts`), and whole flows
  through `integration/harness.ts`.
- Keep OS code thin and behind a small function or trait, and test the logic around it on every
  OS (see `features/models.rs`, `tts/selection.rs`).
- Don't silence coverage with ignore comments: test the line, or remove it.
