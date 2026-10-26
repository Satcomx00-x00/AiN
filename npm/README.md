# AiN

A dynamic-island style widget bar for the desktop. Installs the app for your platform from npm:

```sh
bun i -g @satcomx00/ain   # or: npm i -g @satcomx00/ain
ain                       # starts it
```

Only the build for your machine is downloaded. To pick one yourself, install it directly:

| Platform | Package |
| --- | --- |
| Windows x64 | `@satcomx00/ain-win32-x64` |
| macOS x64 (Intel, Apple silicon through Rosetta) | `@satcomx00/ain-darwin-x64` |
| Linux x64 (AppImage, any distro) | `@satcomx00/ain-linux-x64` |
| Fedora 44 x64 (built on Fedora, uses its libraries) | `@satcomx00/ain-fedora44` |

Update with `bun update -g @satcomx00/ain` (or `npm update -g @satcomx00/ain`): copies installed
this way don't update themselves.

Needs WebView2 on Windows (built into Windows 11), and FUSE 2 on Linux for the AppImage
(`libfuse2`, `fuse-libs`). npm can't tell Linux distros apart, so the Fedora build is only installed
by name, with its libraries from dnf:

```sh
sudo dnf install webkit2gtk4.1 gtk-layer-shell libayatana-appindicator-gtk3
bun i -g @satcomx00/ain-fedora44
```
 Installers, features and docs: https://github.com/Satcomx00-x00/AiN
