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
| Linux x64 (AppImage, any distro) | `@satcomx00/ain-linux-x64` |
| Fedora 43 x64 (built on Fedora, uses its libraries) | `@satcomx00/ain-fedora43` |
| Fedora 44 x64 (built on Fedora, uses its libraries) | `@satcomx00/ain-fedora44` |

Remove it with `ain uninstall` (`ain uninstall --purge` also deletes the settings and downloaded
speech models): it turns off launching at login first, which `bun rm -g` alone would leave behind.
Keep a single copy of AiN: `ain` won't start while one from an installer is on the machine.

Update with `bun update -g @satcomx00/ain` (or `npm update -g @satcomx00/ain`): copies installed
this way don't update themselves.

Needs Node.js 18+ or Bun, and per platform: WebView2 on Windows (built into Windows 11); FUSE 2 and glibc 2.39+ on Linux for the AppImage (`libfuse2t64`
on Ubuntu/Debian, `fuse-libs` on Fedora). The full table is in the
[main README](https://github.com/Satcomx00-x00/AiN#what-each-install-needs). npm can't tell Linux distros apart, so the Fedora build is only installed
by name, with its libraries from dnf:

```sh
sudo dnf install webkit2gtk4.1 gtk-layer-shell libayatana-appindicator-gtk3 alsa-lib
bun i -g @satcomx00/ain-fedora44   # or ain-fedora43
```
 Installers, features and docs: https://github.com/Satcomx00-x00/AiN
