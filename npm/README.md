# npm packages

`npm install --global ain-app` installs AiN without an installer, a compiler or admin rights. The app is the same
build a release ships; npm only carries it.

| Package | Holds | Installed on |
| --- | --- | --- |
| `ain-app` | `ain`, the launcher ([`ain-app/bin/ain.js`](ain-app/bin/ain.js)), and the platform packages as optional dependencies | everywhere |
| `ain-app-linux-x64` | the AppImage | Linux x64, glibc |
| `ain-app-darwin-x64` | `AiN.app` | macOS (Apple silicon through Rosetta) |
| `ain-app-win32-x64` | `ain.exe` | Windows x64 |

npm installs only the platform package whose `os`, `cpu` and `libc` match, from the table in
[`ain-app/lib/target.js`](ain-app/lib/target.js); the launcher finds it there too, and starts it: the AppImage
directly (unpacking itself where FUSE is missing), the `.app` through `open` (so AiN asks for macOS permissions in
its own name), the `.exe` directly. It returns at once; `AIN_FOREGROUND=1 ain` waits, with the app's output.

The app turns its own updater off when it runs from a `node_modules` folder: `npm update --global ain-app` updates
it.

## Releases

[`stage.mjs`](stage.mjs) lays out one package in a folder, for `npm pack`. In the release workflow, each build packs
its platform package and uploads it; once the GitHub release is published, the `npm` job publishes the three
platform packages, then the launcher pinned to them, all at the release's version and with provenance. Versions
already on npm are skipped, so re-running the job publishes only what is missing.

Publishing waits for npm to be set up. Until then the job warns and skips:

1. **First release:** add an npm [granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
   that may publish (read and write, all packages) as the `NPM_TOKEN` repository secret. That release creates the
   four packages.
2. **Then, without a token:** on npmjs.com, add a trusted publisher to each of the four packages (repository
   `Satcomx00-x00/AiN`, workflow `release.yml`), set the repository variable `NPM_TRUSTED_PUBLISHING` to `true`, and
   delete the secret. npm then trusts the workflow's OIDC token alone.

CI checks the packages on every pull request: [`packages.test.mjs`](packages.test.mjs) and the JSDoc types
(`cd ain && bunx tsc -p ../npm`), and the AppImage job installs its AppImage through npm and launches it with `ain`.

## Trying it locally

After `bun run tauri build` (Linux: `--bundles appimage`), from the repository root:

```sh
version=$(jq -r .version ain/package.json)
node npm/stage.mjs linux-x64 "$version" ain/src-tauri/target/release /tmp/npm/linux-x64   # or darwin-x64, win32-x64
node npm/stage.mjs launcher "$version" /tmp/npm/launcher
npm pack /tmp/npm/linux-x64 /tmp/npm/launcher --pack-destination /tmp/npm
npm install --global --omit=optional /tmp/npm/*.tgz
ain
```
