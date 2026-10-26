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

/** Waits for the auto-login GNOME session: the shell, its Wayland socket and XWayland's cookie. */
export async function waitDesktop(guest: Guest): Promise<void> {
  await guest.ok(
    `for i in $(seq 1 90); do
       pgrep -x gnome-shell >/dev/null && [ -S /run/user/$(id -u)/wayland-0 ] &&
         ls /run/user/$(id -u)/.mutter-Xwaylandauth.* >/dev/null 2>&1 && exit 0
       sleep 2
     done
     echo "no GNOME session after 180s"; exit 1`,
    "waiting for the desktop",
  );
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
 * protocol), with the vendored crates and no network. Built in the template's target folder,
 * which holds the dependencies already built and the archives build scripts downloaded.
 * Returns the build's output.
 */
export async function build(guest: Guest, host: Host, log: (s: string) => void): Promise<string> {
  const script = `${ENV}
set -o pipefail
target=$HOME/dev/AiN/ain/src-tauri/target
[ -d "$target" ] || target=$HOME/vmtest/target
export CARGO_TARGET_DIR=$target SHERPA_ONNX_ARCHIVE_DIR=$HOME/vmtest/fetch
mkdir -p "$SHERPA_ONNX_ARCHIVE_DIR"
cd ${REMOTE}/src/src-tauri
cargo build --release --locked --offline --features tauri/custom-protocol \\
  --config 'source.crates-io.replace-with="vendored"' \\
  --config "source.vendored.directory=\\"$HOME/vmtest/vendor\\"" 2>&1 | grep -vE '^\\s+(Compiling|Downloaded|Checking) '
status=\${PIPESTATUS[0]}
[ "$status" = 0 ] && install -m755 "$target/release/ain" ${REMOTE}/ain
exit "$status"`;
  for (let attempt = 1; ; attempt++) {
    const r = await guest.sh(script);
    const out = r.stdout.toString("utf8") + r.stderr;
    if (r.code === 0) return out;
    // A build script wants an archive from the internet: fetch it here and hand it over.
    const want = /SHERPA_ONNX_ARCHIVE_DIR does not contain expected archive: (\S+)/.exec(out)?.[1];
    if (attempt === 1 && want) {
      const name = basename(want);
      const version = /v?(\d+\.\d+\.\d+)/.exec(name)?.[1] ?? (await sherpaVersion(guest));
      log(`the build wants ${name}: fetching it here`);
      const file = await host.fetch(`https://github.com/k2-fsa/sherpa-onnx/releases/download/v${version}/${name}`);
      await guest.upload(file, `${REMOTE}/fetch/${name}`);
      continue;
    }
    throw new Error(`build failed\n${out.trim().split("\n").slice(-40).join("\n")}`);
  }
}

async function sherpaVersion(guest: Guest): Promise<string> {
  return (await guest.ok(`sed -n 's/^version = "\\(.*\\)"/\\1/p' ${REMOTE}/vendor/sherpa-onnx-sys/Cargo.toml | head -1`)).trim();
}
