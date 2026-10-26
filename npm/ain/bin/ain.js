#!/usr/bin/env node
// @ts-check
// Starts AiN: from this package when it is a platform package installed by name, else from the one
// npm/bun picked among the optional dependencies.
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const platform = `@satcomx00/ain-${process.platform}-${process.arch}`;

/** @param {string} message @returns {never} */
const fail = (message) => {
  console.error(`ain: ${message}`);
  process.exit(1);
};

/** The `executable` a package's manifest names, as an absolute path, if it names one. @param {string} manifest */
const named = (manifest) => {
  /** @type {{ executable?: unknown }} */
  const { executable } = require(manifest);
  return typeof executable === "string" ? join(dirname(manifest), executable) : undefined;
};

/** The platform package of this machine's manifest. */
const platformManifest = () => {
  try {
    return require.resolve(`${platform}/package.json`);
  } catch {
    return fail(
      `no build for ${process.platform}-${process.arch} (${platform} isn't installed).\n` +
        "Reinstall without --omit=optional, or get an installer: https://github.com/Satcomx00-x00/AiN/releases",
    );
  }
};

/** The app's path. */
const executable = () =>
  named(require.resolve("../package.json")) ??
  named(platformManifest()) ??
  fail(`${platform} names no executable.`);

/** Some package managers drop the executable bit: put it back. @param {string} path */
const ensureExecutable = (path) => {
  if (process.platform === "win32") return;
  try {
    accessSync(path, constants.X_OK);
  } catch {
    chmodSync(path, 0o755);
  }
};

const app = executable();
ensureExecutable(app);
// A desktop app: detached, so the terminal is free again and closing it leaves the app running.
spawn(app, process.argv.slice(2), { detached: true, stdio: "ignore" })
  .on("error", (e) => fail(`could not start ${app}: ${e.message}`))
  .unref();
