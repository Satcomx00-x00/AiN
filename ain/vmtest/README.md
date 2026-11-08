# VM tests

The app on real Linux desktops: each revision built on Fedora test VMs in Proxmox, then driven
in their GNOME (Wayland) session with a real pointer and keyboard. CI's launch check runs on a
virtual X display; this covers what only a desktop shows: XWayland, GNOME's window rules, the
clipboard between Wayland and X11 apps, typing through `ydotool`.

```sh
bun run vmtest                       # the working tree, on every target, every test
bun run vmtest --targets f44 --tests hover,tabs
bun run vmtest --targets f44dev --tests shortcuts
bun run vmtest --ref v0.11.0         # a commit, tag or branch
bun run vmtest --no-build            # again, on the build already on the VMs
bun run vmtest --list
```

All targets run at once. Each run writes `vmtest/results/<time>/`:

| | |
|---|---|
| `summary.md` | the matrix of checks × targets, failures, and what to check on screenshots |
| `junit.xml`, `results.json` | the same, for tools |
| `<target>/run.log` | everything: delivery, the build's output, each test's output |
| `<target>/shots/*.png` | the VM's screen when a test asked for it |

The exit code is 1 if a check failed or a target couldn't run.

## Targets

| target | template | test VM |
|---|---|---|
| `f43` | 9002 `TPL-FEDORA-43-SILVERBLUE` (GNOME 49) | 412 |
| `f44` | 9003 `TPL-FEDORA-44-SILVERBLUE` (GNOME 50) | 413 |
| `f44dev` | — (an existing dev desktop) | 207, `192.168.1.181` |

Set in [targets.ts](targets.ts). A test VM is a linked clone of its template, made on first use and
then kept, running, between runs (it's quicker, and the build is incremental). It is tagged
`vmtest`; the runner won't touch a VM without that tag. `--fresh` deletes and reclones it, `--stop`
shuts it down at the end.

`f44dev` is a **direct** target: the Fedora 44 Workstation dev desktop (VM 207) is tested in place,
as a real long-lived machine. The runner never clones, recreates or shuts it down (`--fresh` is
refused, `--stop` skips it), keeps its SSH host key between runs, and backs up the app's folders
and the desktop's portal permissions before the first test, restoring them after the last — every
test starts the app from its default settings, so the dev desktop's own state would otherwise be
lost. Models are never copied (they are gigabytes) or removed. A direct target needs a desktop
user reachable over SSH (here `satcom`), a GNOME Wayland session on seat0, and `ydotool`'s daemon
with its socket in that user's runtime folder; see [A direct VM](#a-direct-vm).

The templates are Silverblue desktops prepared for AiN: auto-login, no lock screen, the build and
runtime libraries, Rust through mise, `ydotool` usable by the user. Their Proxmox notes say how.

## A direct VM

A direct target is a desktop that already exists, so its preparation is not in the templates. The
dev desktop is set up once, as root:

```sh
# The tools the tests drive the desktop with, and the build's system libraries.
dnf install -y ydotool xdotool python3-gobject gcc webkit2gtk4.1-devel gtk3-devel \
  gtk-layer-shell-devel libayatana-appindicator-gtk3-devel librsvg2-devel openssl-devel \
  alsa-lib-devel libxdo-devel dbus-devel pipewire-devel wayland-devel \
  mesa-libgbm-devel mesa-libEGL-devel libxcb-devel libXrandr-devel gcc-c++ cmake \
  pkgconf-pkg-config clang clang-devel file patchelf pulseaudio-utils

# A GNOME session on seat0 without a greeter in the way.
cat >/etc/gdm/custom.conf <<'EOF'
[daemon]
AutomaticLoginEnable=True
AutomaticLogin=satcom
EOF

# ydotool's daemon must own its socket in the desktop user's runtime folder: Fedora's own unit
# leaves it root-only under /tmp, where the client does not look.
cat >/etc/systemd/system/ydotoold-ain.service <<'EOF'
[Unit]
Description=ydotool daemon for AiN VM tests
After=systemd-user-sessions.service
[Service]
ExecStart=/usr/bin/ydotoold --socket-path=/run/user/1000/.ydotool_socket --socket-own=1000:1000
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now ydotoold-ain.service
```

Keep the test desktop unlocked and awake: an idle GNOME locks or blanks after a few minutes, and
the pointer and keys would then go to the lock screen. The runner enforces this on every target
(`quietDesktop`), but a direct VM should have it in its own session too. The runner restarts the
session when a setting changes (or a lock is up), so the test user needs passwordless sudo, as on
the templates:

```sh
# as root
echo 'satcom ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/90-ain-vmtest
chmod 0440 /etc/sudoers.d/90-ain-vmtest

# as the desktop user (satcom)
gsettings set org.gnome.desktop.session idle-delay 0
gsettings set org.gnome.desktop.screensaver lock-enabled false
gsettings set org.gnome.desktop.screensaver idle-activation-enabled false
gsettings set org.gnome.settings-daemon.plugins.power idle-dim false
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type nothing
```

The guest scripts choose a Python with PyGObject for the Gtk clipboard helpers (a mise-installed
Python usually has none), use the distribution's `gnome-text-editor` when the Text Editor flatpak
is not installed, and export `YDOTOOL_SOCKET` so the client talks to the daemon above.

The pointer is an **absolute uinput device**, built from `guest/ain-pointer.c` on the guest (needs
`cc`) and started as a transient root service with a FIFO in the desktop user's runtime folder.
A synthetic *relative* mouse goes through the desktop's pointer acceleration; on the dev VM a long
move is scaled ~2x, so the pointer misses the pill. Absolute events are not accelerated, and the
helper moves to an exact screen pixel. When it can't be built or started (no sudo, no compiler),
the scripts fall back to ydotool's relative moves.

## The settings the tests drive

Before each target, the runner generates `guest/settings.test.json` from the source under test:
the app's defaults, `general.greeting` set to `"none"`, and the tab order in `TABS`
(media, clock, timer, volume, clipboard, stats, privacy, dictation, tts, persona, …). `start_app`
copies it after wiping the app's folders, so every test drives the same layout. The startup
animation is off because the island attaches its pointer listeners after the animation's promise;
on a software-rendered VM that promise can stall (WebKit pauses the animation while the window has
no focus), and the pill is drawn but inert. The animation has its own frontend tests.

The **GlobalShortcuts grant** is forgotten before each start (`reset_shortcut_grant`). With a
remembered grant, GNOME 50's portal answers `BindShortcuts` without its dialog, and on this desktop
that path leaves the web view inert (the window takes focus, but pointer events never reach the
page). Forgetting the grant makes every start take the dialog path, where the island is
interactive; `answer_shortcuts_dialog` answers it, and the runner restores the desktop's own grant
after the run. This is a workaround for an app/portal interaction: remove it when the app handles
the remembered-grant path.

## Stability and shortcuts

The suite is more than one check per feature; it also runs the app hard and measures what happens:

| File | What it proves |
|---|---|
| `91-stability` | 20 hover/open/tab/fold cycles: still alive, centered, one window, bounded memory, file descriptors and threads |
| `92-rapid` | rapid open/fold at the island's edge and quick tab clicks: no crash, no stale window, no drift |
| `93-restart` | three stop/start cycles with settings kept: folded, centered, one process, Settings still opens |
| `94-shortcut-soak` | the clipboard shortcut fired ten times: popup each time, no leftover window, no leak |
| `95-shortcuts` | the real global shortcuts through GNOME's portal: popup commands, zones, capture, action commands, and the grant surviving a restart |
| `96-environment` | the desktop itself: GNOME on seat0, XWayland, ydotool, and the GlobalShortcuts / RemoteDesktop / Screenshot portals |
| `97-window-rules` | GNOME window state: above, sticky, skip-taskbar, shaped input; Settings is an ordinary window |

Numbers are reported with `metric ID NAME VALUE` and collected in the summary's **Metrics** table
(and in `results.json`), so a leak shows as a trend across runs even while the checks still pass.
The stability files ask for more time with `# timeout: 900` at the top of the file; the runner
reads that directive (300 s otherwise).

## What this machine needs

- `git`, `bun`, `cargo`, `ssh` and `tar` on PATH.
- SSH as root to the Proxmox host (`ssh root@192.168.1.100` without a password): screenshots come
  from QEMU's monitor, and the host's CA (which the API's certificate is checked against) is read
  that way. `PVE_CA` can point at the CA's PEM instead.
- An API token: `PVE_TOKEN` (`user@realm!name=secret`), or the Proxmox MCP server's config
  (`~/.config/proxmox-mcp/config.json`, or `PVE_CONFIG`). `PVE_HOST` and `PVE_NODE` override the
  host and node.

## Offline guests

The VMs have no internet, so everything comes from this machine, cached in `vmtest/.cache`:

1. **The revision**: a detached worktree at the commit under test (by default `git stash create`'s
   snapshot of the working tree's tracked files: untracked files aren't tested), where
   `bun install` and `vite build` make `dist`. Guests build only the Rust side, with the frontend
   embedded, as `tauri build` does (`cargo build --release --features tauri/custom-protocol`).
2. **Crates**: `cargo vendor` once per `Cargo.lock`; each guest is sent only the crates it lacks.
3. **Tools**: CMake (for libopus) from Kitware, checked against its SHA-256. sherpa-onnx's
   libraries come with the source (`src-tauri/vendor/sherpa-onnx`): the build downloads nothing.

The guest builds in the template's target folder (`~/dev/AiN/ain/src-tauri/target`), which already
holds the built dependencies. Rust is the template's: a revision needing a newer toolchain needs
new templates.

## The desktop

Before the tests, the runner makes sure GNOME is in a state to be driven:

- **The session on screen**: after a reboot, the seat can show GDM's greeter while the auto-login
  session runs on unseen (its windows exist but aren't shown; input goes to the greeter). The
  runner switches the seat back to the session.
- **No banners**: notification banners appear at the top centre, over the island (GNOME 49's
  "Support GNOME" reminder blocked every hover). Banners and that reminder are turned off; the
  first time, the VM restarts so a banner already up goes away.
- **No overview**: GNOME opens its overview at login; `start_app` leaves it.

## Writing a test

A test is a bash file in [guest/tests](guest/tests), run in the desktop session in name order; it
prints its results, one line each. Helpers come from [guest/lib.sh](guest/lib.sh):

```bash
# Clicking the stats tab shows CPU and memory.
ensure_app                     # the app running (start_app: restart from the default settings)
tab stats                      # open the island and click a tab (names in TABS)
geom "$(island)"               # the island's X Y WIDTH HEIGHT
check T20 "stays open" '[ "$HEIGHT" -gt 100 ]' "${WIDTH}x$HEIGHT"
shot stats                     # the VM's screen, saved as shots/stats.png
look T21 "CPU and RAM bars show" stats
fold_island
```

- `check ID WHAT CONDITION DETAIL`: PASS or FAIL; DETAIL says what was seen.
- `look ID WHAT SHOT`: a result only a screenshot shows; listed in the summary to check.
- `metric ID NAME VALUE`: a number for the summary's Metrics table.
- `wait_for SECONDS CONDITION` rather than `sleep`: GNOME and the web view take their time,
  more on a busy host.
- The pointer: `reach X Y` onto the island, `glide_to`/`hover_click` within it, `point X Y`
  elsewhere, `under` (the X11 window under it); keys: `keys CODE...` (Linux key codes, the same
  whatever the keyboard layout), `chord KEYCODE MODIFIER...` for a global shortcut.
- The app: `start_app` (default settings), `restart_app` (settings kept), `stop_app`, `app_alive`,
  `resources PID` (RSS, file descriptors, threads), `cycle_tabs N`, `cycle_settings N`, `gear`.
- The app's windows: `app_windows`, `window_count`, `snapshot_windows` then `wait_new_window`
  (sets `NEW_WINDOW`), `window_title`, `window_visible`, `wait_window_gone`.
- Move as a hand does: XWayland sees the pointer only over X11 windows, so the island notices it
  leave only if it crosses its edge (`fold_island` glides out), and the web view wants a little
  motion before a hover or a click counts.
- Each file should stand alone (`ensure_app`, `open_island`/`fold_island`), so `--tests` can pick any.
- A file that soaks starts with `# timeout: 900`: the runner allows that many seconds instead of 300.

The island's tab positions (`TABS`, `TAB_X`, `TAB_DX10`) follow the default layout: update them
when it changes. The screenshots of `30-tabs` show what each click opened.
