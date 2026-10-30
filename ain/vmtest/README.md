# VM tests

The app on real Linux desktops: each revision built on Fedora test VMs in Proxmox, then driven
in their GNOME (Wayland) session with a real pointer and keyboard. CI's launch check runs on a
virtual X display; this covers what only a desktop shows: XWayland, GNOME's window rules, the
clipboard between Wayland and X11 apps, typing through `ydotool`.

```sh
bun run vmtest                       # the working tree, on every target, every test
bun run vmtest --targets f44 --tests hover,tabs
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

Set in [targets.ts](targets.ts). A test VM is a linked clone of its template, made on first use and
then kept, running, between runs (it's quicker, and the build is incremental). It is tagged
`vmtest`; the runner won't touch a VM without that tag. `--fresh` deletes and reclones it, `--stop`
shuts it down at the end.

The templates are Silverblue desktops prepared for AiN: auto-login, no lock screen, the build and
runtime libraries, Rust through mise, `ydotool` usable by the user. Their Proxmox notes say how.

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
- `wait_for SECONDS CONDITION` rather than `sleep`: GNOME and the web view take their time,
  more on a busy host.
- The pointer: `reach X Y` onto the island, `glide_to`/`hover_click` within it, `point X Y`
  elsewhere, `under` (the X11 window under it); keys: `keys CODE...` (Linux key codes, the same
  whatever the keyboard layout). Move as a hand does: XWayland sees the pointer only over X11
  windows, so the island notices it leave only if it crosses its edge (`fold_island` glides out),
  and the web view wants a little motion before a hover or a click counts.
- Each file should stand alone (`ensure_app`, `open_island`/`fold_island`), so `--tests` can pick any.

The island's tab positions (`TABS`, `TAB_X`, `TAB_DX10`) follow the default layout: update them
when it changes. The screenshots of `30-tabs` show what each click opened.
