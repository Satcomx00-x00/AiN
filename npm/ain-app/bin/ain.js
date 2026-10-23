#!/usr/bin/env node
// @ts-check
// `ain`: starts the AiN build npm installed for this OS, then returns (AiN keeps running in the
// tray). AIN_FOREGROUND=1 waits for it instead, with its output in the terminal.
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { command, packageName, platformFor } from "../lib/target.js";

const RELEASES = "https://github.com/Satcomx00-x00/AiN/releases";

/** @param {string} message @returns {never} */
const fail = (message) => {
  console.error(`ain: ${message}`);
  process.exit(1);
};

/** npm keeps the executable bit, but a copied or unzipped install may lose it. @param {string} path */
const ensureExecutable = (path) => {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    try {
      chmodSync(path, 0o755);
    } catch {
      // Not ours to change (a root-owned global install): starting it says what's wrong.
    }
  }
};

/** Where npm put package `name`, next to this one or in its own node_modules. @param {string} name */
const installed = (name) => {
  try {
    return dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  } catch {
    return fail(`${name} isn't installed. Reinstall without --omit=optional: npm install --global ain-app`);
  }
};

const id = platformFor(process.platform, process.arch) ?? fail(`no build for ${process.platform} on ${process.arch}. Installers: ${RELEASES}`);
const dir = installed(packageName(id));

const foreground = process.env.AIN_FOREGROUND === "1";
const run = command(id, dir, process.argv.slice(2), { fuse: existsSync("/dev/fuse"), wait: foreground });
if (process.platform !== "win32") ensureExecutable(run.executable);

const child = spawn(run.file, run.args, {
  env: { ...process.env, ...run.env },
  detached: !foreground,
  stdio: foreground ? "inherit" : "ignore",
});
child.on("error", (e) => fail(`couldn't start ${run.file}: ${e.message}`));
if (foreground) {
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  child.unref();
}
