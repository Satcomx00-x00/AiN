/** Getting a guest from its template's state to the build under test, offline. */
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Guest } from "./guest.ts";
import type { Host, Stage, Vendor } from "./stage.ts";

/** Where everything lives on the guest. */
export const REMOTE = "~/vmtest";

const ENV = `
export PATH=$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/share/mise/shims:$PATH
`;

/**
 * Waits for the auto-login GNOME session (the shell, its Wayland socket, XWayland's cookie), and
 * makes sure it's the one on screen: the seat can be on GDM's greeter instead (seen after a
 * reboot), where the session runs on unseen, and the pointer and keys go to the greeter.
 */
export async function waitDesktop(guest: Guest): Promise<void> {
  await guest.ok(
    `for i in $(seq 1 90); do
       pgrep -u "$(id -u)" -x gnome-shell >/dev/null && [ -S /run/user/$(id -u)/wayland-0 ] &&
         ls /run/user/$(id -u)/.mutter-Xwaylandauth.* >/dev/null 2>&1 && break
       sleep 2
     done
     mine=$(loginctl list-sessions --no-legend | awk -v u="$(id -u)" '$2 == u && $4 == "seat0" { print $1; exit }')
     [ -n "$mine" ] || { echo "no GNOME session on seat0 after 180s"; exit 1; }
     for i in $(seq 1 10); do
       [ "$(loginctl show-seat seat0 -p ActiveSession --value)" = "$mine" ] && exit 0
       sudo loginctl activate "$mine"
       sleep 2
     done
     echo "seat0 shows session $(loginctl show-seat seat0 -p ActiveSession --value), not ours ($mine)"; exit 1`,
    "waiting for the desktop",
  );
}

/**
 * Keeps GNOME's own pop-ups off the screen: a notification banner sits at the top centre, over
 * the island (GNOME 49's "Support GNOME" reminder did). Returns true if a setting changed: a banner
 * already showing stays until the session restarts.
 */
export async function quietDesktop(guest: Guest): Promise<boolean> {
  const out = await guest.ok(
    `export XDG_RUNTIME_DIR=/run/user/$(id -u)
     set_off() {
       gsettings writable "$1" "$2" >/dev/null 2>&1 || return 0
       [ "$(gsettings get "$1" "$2")" = false ] && return 0
       gsettings set "$1" "$2" false && echo changed
     }
     set_off org.gnome.desktop.notifications show-banners
     set_off org.gnome.settings-daemon.plugins.housekeeping donation-reminder-enabled`,
    "turning GNOME's notifications off",
  );
  return out.includes("changed");
}

/**
 * Whether GNOME's helper that draws X11 windows' title bars (mutter-x11-frames) quit in this
 * session: it does on an X error (a window destroyed under it), isn't started again, and GNOME then
 * keeps every decorated X11 window hidden ("Iconic"). Only a new session brings it back.
 */
export async function framesHelperDied(guest: Guest): Promise<boolean> {
  const r = await guest.sh(`journalctl --user -b --no-pager -o cat SYSLOG_IDENTIFIER=mutter-x11-frames 2>/dev/null | grep -q "X Window System error"`);
  return r.code === 0;
}

/** Restarts the guest and waits for its desktop again. */
export async function reboot(guest: Guest): Promise<void> {
  await guest.exec("sudo systemctl reboot");
  await new Promise((r) => setTimeout(r, 15_000));
  await guest.waitSsh();
  await waitDesktop(guest);
}

/** The test scripts (vmtest/guest), replacing the previous run's. */
export async function sendGuestScripts(guest: Guest, app: string): Promise<void> {
  await guest.ok(`rm -rf ${REMOTE}/guest`);
  await guest.send(join(app, "vmtest", "guest"), ["."], `${REMOTE}/guest`);
}

export async function ensureCmake(guest: Guest, host: Host): Promise<void> {
  const r = await guest.sh(`${ENV} command -v cmake`);
  if (r.code === 0) return;
  const tarball = await host.cmake();
  await guest.upload(tarball, `/tmp/${basename(tarball)}`);
  await guest.ok(
    `mkdir -p ~/.local/opt ~/.local/bin && tar -xzf /tmp/${basename(tarball)} -C ~/.local/opt &&
     ln -sf ~/.local/opt/${basename(tarball, ".tar.gz")}/bin/cmake ~/.local/bin/cmake && rm /tmp/${basename(tarball)}`,
    "installing CMake",
  );
}

/** Brings the guest's vendor folder to the stage's crates, sending only those it lacks. Returns how many were sent. */
export async function syncVendor(guest: Guest, host: Host, vendor: Vendor, name: string): Promise<number> {
  const have = JSON.parse(await guest.ok(`python3 ${REMOTE}/guest/vendor-sums.py ${REMOTE}/vendor`, "listing crates")) as Record<string, string>;
  const safe = (n: string) => /^[\w.+-]+$/.test(n);
  const stale = Object.keys(have).filter((n) => safe(n) && vendor.crates.get(n) !== have[n]);
  const missing = [...vendor.crates.keys()].filter((n) => have[n] !== vendor.crates.get(n));
  if (stale.length) await guest.ok(`cd ${REMOTE}/vendor && rm -rf -- ${stale.join(" ")}`, "removing old crates");
  if (missing.length) {
    const list = join(host.cache, `send-${name}.txt`);
    writeFileSync(list, missing.join("\n") + "\n");
    await guest.send(vendor.dir, { list }, `${REMOTE}/vendor`);
  }
  return missing.length;
}

/** The staged app (source and built `dist`, without node_modules), replacing the previous run's. */
export async function sendSource(guest: Guest, stage: Stage): Promise<void> {
  await guest.ok(`rm -rf ${REMOTE}/src`);
  await guest.send(stage.app, ["."], `${REMOTE}/src`, ["./node_modules", "./src-tauri/target", "./vmtest/.cache", "./vmtest/results"]);
}

/**
 * A release build, as `tauri build` makes it (the frontend embedded, served by the custom
 * protocol), with the vendored crates and no network: sherpa-onnx's libraries come from the
 * source's own src-tauri/vendor/sherpa-onnx. Built in the template's target folder, which holds the
 * dependencies already built. Returns the build's output.
 */
export async function build(guest: Guest): Promise<string> {
  const script = `${ENV}
set -o pipefail
target=$HOME/dev/AiN/ain/src-tauri/target
[ -d "$target" ] || target=$HOME/vmtest/target
export CARGO_TARGET_DIR=$target
cd ${REMOTE}/src/src-tauri
cargo build --release --locked --offline --features tauri/custom-protocol \\
  --config 'source.crates-io.replace-with="vendored"' \\
  --config "source.vendored.directory=\\"$HOME/vmtest/vendor\\"" 2>&1 | grep -vE '^\\s+(Compiling|Downloaded|Checking) '
status=\${PIPESTATUS[0]}
[ "$status" = 0 ] && install -m755 "$target/release/ain" ${REMOTE}/ain
# The bundle's resources beside the binary, where Tauri looks for them when it isn't installed.
[ "$status" = 0 ] && [ -d resources ] && cp -r resources/. ${REMOTE}/
exit "$status"`;
  const r = await guest.sh(script);
  const out = r.stdout.toString("utf8") + r.stderr;
  if (r.code !== 0) throw new Error(`build failed\n${out.trim().split("\n").slice(-40).join("\n")}`);
  return out;
}
