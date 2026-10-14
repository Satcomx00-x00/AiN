# AiN

All I Needed — a dynamic-island style widget bar for the desktop, built with [Tauri 2](https://tauri.app), TypeScript and Rust.

[![CI](https://github.com/Satcomx00-x00/AiN/actions/workflows/ci.yml/badge.svg)](https://github.com/Satcomx00-x00/AiN/actions/workflows/ci.yml)

## Layout

| Path | Content |
| --- | --- |
| `widget-island/` | The application (Vite + TypeScript frontend) |
| `widget-island/src-tauri/` | The Rust/Tauri backend |
| `cliff.toml` | [git-cliff](https://git-cliff.org) changelog configuration |
| `.github/workflows/` | CI and release pipelines |

## Development

Requirements: [Bun](https://bun.sh) 1.3+, Rust stable, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS
(on Debian/Ubuntu: `.github/scripts/linux-deps.sh`).

```sh
cd widget-island
bun install
bun run tauri dev      # run the app
bun run typecheck      # tsc
bun run test           # vitest
bun run tauri build    # local bundle
```

Rust checks (from `widget-island/src-tauri`): `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.

## Commit convention

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `ci:`, `build:`, `chore:`…).
They are linted in CI, and locally after enabling the hook once per clone:

```sh
git config core.hooksPath .githooks
```

For pull requests the title is linted too, since it becomes the squash-merge commit message.

## CI

Every push to `main` and every pull request runs:

- commit message linting (commitlint)
- frontend: typecheck, unit tests, production build
- Rust: `rustfmt`, then `clippy -D warnings` and `cargo test` on Linux, Windows and macOS (x64)

## Releases

Releases are cut from the **Actions → Release → Run workflow** button on `main`:

1. CI runs as a gate.
2. git-cliff derives the next version from the commits since the last tag (or the bump you pick), updates
   `package.json`, `Cargo.toml`, `Cargo.lock` and `CHANGELOG.md`, commits `chore(release): vX.Y.Z` and pushes the tag.
3. The app is built for **x64 only**: Windows (`.msi`, NSIS `.exe`), Linux (`.deb`, `.rpm`, `.AppImage`) and macOS (`.dmg`, `.app`).
4. The release is published with the changelog section as its notes.

If a build fails, the release stays a draft: fix the cause and re-run the failed jobs.
Binaries are currently unsigned (Windows SmartScreen and macOS Gatekeeper will warn).
