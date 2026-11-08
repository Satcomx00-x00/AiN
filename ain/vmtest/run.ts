/**
 * AiN's VM tests: the revision under test built on each Fedora test VM in Proxmox, then the scripts
 * in guest/tests run in its GNOME session, all targets at once. See README.md.
 *
 *   bun run vmtest [--targets f43,f44] [--tests hover,tabs] [--ref <commit>] [--no-build] [--fresh] [--stop] [--list]
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build, backupState, ensureCmake, framesHelperDied, quietDesktop, REMOTE, reboot, restoreState, screenLocked, sendGuestScripts, sendSource, sendTestSettings, syncVendor, waitDesktop } from "./lib/deliver.ts";
import { Guest } from "./lib/guest.ts";
import { sleep } from "./lib/proc.ts";
import { loadCa, loadToken, Pve } from "./lib/pve.ts";
import { type Check, failed, type Metric, parseLine, parseMetric, type TargetResult, writeReports } from "./lib/report.ts";
import { Host, missingTools, type Stage, type Vendor } from "./lib/stage.ts";
import { PROXMOX, type Target, TARGETS, VM_TAG } from "./targets.ts";

const USAGE = `Usage: bun run vmtest [options]

  --targets f43,f44   the VMs to run on (default: all of ${TARGETS.map((t) => t.name).join(", ")})
  --tests a,b         only the test files whose names contain one of these
  --ref <commit>      test this commit (default: the working tree, tracked files)
  --no-build          run the tests on the build already on the VMs
  --fresh             recreate the test VMs from their templates first
  --stop              shut the VMs down afterwards
  --list              list the targets and tests, and exit`;

const { values: opt } = parseArgs({
  options: {
    targets: { type: "string" },
    tests: { type: "string" },
    ref: { type: "string" },
    "no-build": { type: "boolean", default: false },
    fresh: { type: "boolean", default: false },
    stop: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const app = dirname(here);
const allTests = readdirSync(join(here, "guest", "tests"))
  .filter((f) => f.endsWith(".sh"))
  .sort();

function pick<T>(all: readonly T[], filter: string | undefined, name: (t: T) => string, exact: boolean, what: string): T[] {
  if (!filter) return [...all];
  const wanted = filter.split(",").map((s) => s.trim()).filter(Boolean);
  const chosen = all.filter((t) => wanted.some((w) => (exact ? name(t) === w : name(t).includes(w))));
  const unknown = wanted.filter((w) => !all.some((t) => (exact ? name(t) === w : name(t).includes(w))));
  if (unknown.length) throw new Error(`no ${what} matching ${unknown.join(", ")} (have: ${all.map(name).join(", ")})`);
  return chosen;
}

if (opt.help) {
  console.log(USAGE);
  process.exit(0);
}
const targets = pick(TARGETS, opt.targets, (t) => t.name, true, "target");
const tests = pick(allTests, opt.tests, (f) => f, false, "test");
if (opt.list) {
  for (const t of TARGETS) console.log(t.direct ? `target ${t.name}: VM ${t.vmid} at ${t.address ?? "its address"} (direct)` : `target ${t.name}: VM ${t.vmid}, cloned from template ${t.template}`);
  for (const f of allTests) console.log(`test   ${f}`);
  process.exit(0);
}

const missing = await missingTools();
if (missing.length) throw new Error(`missing on this machine: ${missing.join(", ")}`);

const host = new Host(app);
const pve = new Pve(PROXMOX.host, PROXMOX.node, loadToken(), await loadCa(PROXMOX.host));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(here, "results", stamp);
mkdirSync(out, { recursive: true });
const say = (s: string) => console.log(`[host] ${s}`);

let stage: Stage | undefined;
let vendor: Vendor | undefined;
let title = "the build already on the VMs";
if (!opt["no-build"]) {
  const rev = await host.resolve(opt.ref);
  title = rev.label;
  say(`testing ${rev.label} (${rev.sha.slice(0, 12)}) on ${targets.map((t) => t.name).join(", ")}`);
  stage = await host.stage(rev, say);
  vendor = await host.vendor(stage, say);
}

const results = await Promise.all(targets.map((t) => runTarget(t)));
const summary = writeReports(out, title, results);
console.log(`\n${summary}\nresults: ${out}`);
process.exitCode = failed(results) ? 1 : 0;

async function runTarget(t: Target): Promise<TargetResult> {
  const started = Date.now();
  const dir = join(out, t.name);
  mkdirSync(join(dir, "shots"), { recursive: true });
  const logFile = join(dir, "run.log");
  const log = (s: string) => {
    console.log(`[${t.name}] ${s}`);
    appendFileSync(logFile, `${s}\n`);
  };
  const checks: Check[] = [];
  const metrics: Metric[] = [];
  let ip: string | undefined;
  let error: string | undefined;
  let state: string | undefined;
  let guest: Guest | undefined;
  try {
    ip = await ensureVm(t, log);
    log(`VM ${t.vmid} up at ${ip}`);
    guest = new Guest(ip, join(host.cache, `known_hosts-${t.name}`), t.user, !t.direct);
    await guest.waitSsh();
    // A stopped run leaves its test script and app behind on the guest: they would hold the
    // pointer FIFO, the app unit and the desktop's focus. Clear them before this run.
    await guest.ok(
      `pkill -f 'guest/run[.]sh' 2>/dev/null || true
       pkill -f 'xdotool windowactivate' 2>/dev/null || true
       systemctl --user stop vmtest-ain 2>/dev/null || true
       systemctl --user reset-failed vmtest-ain 2>/dev/null || true
       sudo -n systemctl stop vmtest-pointer 2>/dev/null || true
       sudo -n systemctl reset-failed vmtest-pointer 2>/dev/null || true
       rm -f /run/user/$(id -u)/ain-pointer.fifo 2>/dev/null || true
       true`,
      "cleaning a previous run",
    );
    if (t.direct) {
      state = await backupState(guest);
      log("app state saved: it will be put back after the run");
    }
    await waitDesktop(guest);
    if (await quietDesktop(guest)) {
      log("GNOME's notifications, lock and blanking turned off: restarting the session");
      await reboot(guest);
    } else if (await screenLocked(guest)) {
      log("the session is locked: restarting it");
      await reboot(guest);
    } else if (await framesHelperDied(guest)) {
      log("GNOME's X11 title-bar helper died in this session: restarting it");
      await reboot(guest);
    }
    await sendGuestScripts(guest, app);
    await sendTestSettings(guest, stage?.app ?? app);
    if (stage && vendor) {
      await ensureCmake(guest, host);
      const sent = await syncVendor(guest, host, vendor, t.name);
      log(`crates: ${sent} sent, ${vendor.crates.size - sent} already there`);
      await sendSource(guest, stage);
      log("building");
      const b = Date.now();
      appendFileSync(logFile, await build(guest));
      log(`built in ${Math.round((Date.now() - b) / 1000)} s`);
    } else {
      await guest.ok(`test -x ${REMOTE}/ain`, "no build on the VM yet (run once without --no-build)");
    }
    for (const file of tests) checks.push(...(await runTest(t, guest, file, dir, log, metrics)));
    if (state) {
      await restoreState(guest, state).catch((e: unknown) => log(`restoring the app state failed: ${String(e)}`));
      state = undefined;
      log("app state restored");
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    log(`ERROR ${error}`);
  } finally {
    if (state && guest) await restoreState(guest, state).catch((e: unknown) => log(`restoring the app state failed: ${String(e)}`));
    // The pointer daemon is per run; leave no service of ours behind on any target.
    if (guest) await guest.sh('sudo -n systemctl stop vmtest-pointer 2>/dev/null || true; sudo -n systemctl reset-failed vmtest-pointer 2>/dev/null || true; rm -f /run/user/$(id -u)/ain-pointer.fifo').catch(() => {});
  }
  if (opt.stop && !t.direct) await pve.shutdown(t.vmid).catch((e: unknown) => log(`shutdown failed: ${String(e)}`));
  return { target: t.name, ...(ip ? { ip } : {}), ...(error ? { error } : {}), checks, metrics, seconds: (Date.now() - started) / 1000 };
}

/** The target's test VM, running: created from its template if needed. Returns its address. */
async function ensureVm(t: Target, log: (s: string) => void): Promise<string> {
  if (t.direct) {
    if (opt.fresh) throw new Error(`${t.name} is a direct VM: --fresh would destroy it`);
    const vm = await pve.vm(t.vmid);
    if (!vm) throw new Error(`direct VM ${t.vmid} isn't in Proxmox`);
    if (vm.status !== "running") {
      log(`starting VM ${t.vmid}`);
      await pve.start(t.vmid);
    }
    if (t.address) return t.address;
    for (let i = 0; i < 90; i++) {
      const ip = await pve.ip(t.vmid);
      if (ip) return ip;
      await sleep(2000);
    }
    throw new Error(`VM ${t.vmid}: no address from its guest agent after 180 s`);
  }
  let vm = await pve.vm(t.vmid);
  const ours = (tags?: string) => (tags ?? "").split(/[;,\s]/).includes(VM_TAG);
  if (vm && !ours(vm.tags)) throw new Error(`VM ${t.vmid} (${vm.name}) isn't one of ours (no "${VM_TAG}" tag): pick another vmid in targets.ts`);
  if (vm && opt.fresh) {
    log(`deleting VM ${t.vmid} (--fresh)`);
    await pve.destroy(t.vmid);
    vm = undefined;
  }
  if (!vm) {
    log(`cloning template ${t.template} into VM ${t.vmid}`);
    await pve.clone(t.template, t.vmid, `VMTEST-${t.name.toUpperCase()}`);
    await pve.qemu("PUT", t.vmid, "/config", {
      tags: `${VM_TAG};ain-test;${t.name}`,
      description: `AiN VM test target \`${t.name}\`: linked clone of template ${t.template}, managed by ain/vmtest (\`bun run vmtest\`).`,
    });
  }
  if ((await pve.vm(t.vmid))?.status !== "running") {
    log(`starting VM ${t.vmid}`);
    await pve.start(t.vmid);
  }
  for (let i = 0; i < 90; i++) {
    const ip = await pve.ip(t.vmid);
    if (ip) return ip;
    await sleep(2000);
  }
  throw new Error(`VM ${t.vmid}: no address from its guest agent after 180 s`);
}

/** Runs one test file, taking the screenshots it asks for. */
async function runTest(t: Target, guest: Guest, file: string, dir: string, log: (s: string) => void, metrics: Metric[]): Promise<Check[]> {
  const checks: Check[] = [];
  let shots = Promise.resolve();
  // A file may ask for longer than the default when it runs a soak: `# timeout: 900` at its top.
  const asked = Number(/^#\s*timeout:\s*(\d+)\s*$/m.exec(readFileSync(join(here, "guest", "tests", file), "utf8"))?.[1]);
  const timeout = Number.isFinite(asked) && asked > 0 ? asked : 300;
  const r = await guest.exec(`timeout ${timeout} bash ${REMOTE}/guest/run.sh tests/${file}`, {
    onLine: (line, child) => {
      appendFileSync(join(dir, "run.log"), `${file}: ${line}\n`);
      const shot = /^@@shot (\S+)$/.exec(line)?.[1];
      if (shot) {
        shots = shots
          .then(() => pve.screenshot(t.vmid, join(dir, "shots", `${shot}.png`)))
          .catch((e: unknown) => log(`screenshot ${shot} failed: ${String(e)}`))
          .then(() => void child.stdin?.write("\n"));
        return;
      }
      const metric = parseMetric(file, line);
      if (metric) {
        metrics.push(metric);
        log(`METRIC ${metric.id} ${metric.name} ${metric.value}`);
        return;
      }
      const c = parseLine(file, line);
      if (!c) return;
      checks.push(c);
      log(`${c.status} ${c.id} ${c.what}${c.detail ? ` (${c.detail})` : ""}`);
    },
  });
  await shots;
  if (r.code !== 0 || checks.length === 0) {
    const why = r.code === 124 ? `timed out after ${timeout} s` : `exited with ${r.code}`;
    const tail = r.stderr.trim().split("\n").slice(-3).join(" | ");
    checks.push({ file, id: file.replace(/\.sh$/, ""), what: "test file ran to the end", status: "ERROR", detail: `${checks.length ? why : `${why}, no results`}${tail ? `: ${tail}` : ""}` });
    log(`ERROR ${file}: ${why}${tail ? `: ${tail}` : ""}`);
  }
  return checks;
}
