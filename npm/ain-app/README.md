# AiN on npm

[AiN](https://github.com/Satcomx00-x00/AiN) is a dynamic-island style widget bar for the desktop, with a clipboard
picker, a screenshot editor, dictation, a command palette and window zones, on Windows, macOS and Linux.

```sh
npm install --global ain-app
ain
```

`ain` starts AiN and returns: it keeps running in the tray. To see its output instead, run `AIN_FOREGROUND=1 ain`.

npm installs only the build for your system, with nothing to compile:

| System | Build |
| --- | --- |
| Linux x64 (glibc) | The AppImage, with its own WebKitGTK and GTK: no system packages to install |
| macOS | The Intel `.app` (Apple silicon runs it through Rosetta) |
| Windows x64 | `ain.exe` (WebView2 comes with Windows 10 and 11) |

Update with `npm update --global ain-app`: AiN's own updater stays off in this install. Uninstall with
`npm uninstall --global ain-app`.

Installers for each system, and what each feature needs, are in the
[README](https://github.com/Satcomx00-x00/AiN#install).
