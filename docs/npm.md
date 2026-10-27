# npm and bun

`bun i -g @satcomx00/ain` (or `npm i -g`) installs AiN without an installer. The code is in
[`npm/`](../npm); the release workflow publishes it.

## Packages

| Package | Contents |
| --- | --- |
| `@satcomx00/ain` | the `ain` command ([`npm/ain/bin/ain.js`](../npm/ain/bin/ain.js)), and one optional dependency per platform |
| `@satcomx00/ain-win32-x64` | `ain.exe` |
| `@satcomx00/ain-darwin-x64` | `AiN.app` |
| `@satcomx00/ain-linux-x64` | `AiN.AppImage` |
| `@satcomx00/ain-fedora43`, `@satcomx00/ain-fedora44` | `ain`, built on that Fedora against its WebKitGTK; never picked automatically |

Each platform package declares its `os` and `cpu`, so npm and bun install only the one matching the
machine, as esbuild or Biome do. npm can't tell distros apart, so the Fedora packages are not among
`@satcomx00/ain`'s optional dependencies. Every platform package also carries the `ain` command, so
any of them can be installed on its own by name. `ain` finds the app through the `executable` field
of its own `package.json`, else of the platform package, and starts it detached.

The app turns its own updater off when it runs from `node_modules` (see
[`updater.rs`](../ain/src-tauri/src/shell/updater.rs)): the package manager updates it.

## Uninstalling, and one copy at a time

npm and bun run nothing when a package is removed, so `ain uninstall [--purge]` does the cleanup
first: it starts the app with `--cleanup` ([`cleanup.rs`](../ain/src-tauri/src/shell/cleanup.rs)),
which removes the launch-at-login entry (and with `--purge` the app's folders), then runs
`bun remove -g` or `npm rm -g` for the package it came from.

Two copies would share settings and the launch-at-login entry, so `ain` refuses to start when an
installer's copy exists: `%LOCALAPPDATA%\AiN` or `%ProgramFiles%\AiN` (Windows),
`/Applications/AiN.app` or `~/Applications/AiN.app` (macOS), `/usr/bin/ain` (`.deb`, `.rpm`).

## Release

1. Each build job of [`release.yml`](../.github/workflows/release.yml) uploads its app as an
   `npm-<platform>` artifact, and a container job builds `npm-fedora43` and `npm-fedora44`.
2. Once the GitHub release is public, the `npm` job runs [`npm/build.ts`](../npm/build.ts), which
   writes the packages for that version, then publishes the platform packages and the main package
   last.

[CI](../.github/workflows/ci.yml) builds the packages from stand-in binaries, installs them from their
tarballs and runs `ain`.

## Setup (once)

Publishing is off until the repository variable `NPM_PUBLISH` is `true`.

1. On npmjs.com, create the `satcomx00` organization (free, public packages).
2. Create a granular access token that can publish to `@satcomx00`, and save it as the `NPM_TOKEN`
   secret. npm only lets a package that already exists use trusted publishing, so the first
   release needs this token.
3. Set `NPM_PUBLISH` to `true` (Settings › Secrets and variables › Actions › Variables) and release.
4. For each of the six packages, add a trusted publisher on npmjs.com (package › Settings): GitHub
   Actions, repository `Satcomx00-x00/AiN`, workflow `release.yml`. Then delete the `NPM_TOKEN`
   secret. From then on the job publishes through OIDC, with provenance, and no token is stored.
