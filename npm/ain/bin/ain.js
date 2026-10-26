#!/usr/bin/env node
// @ts-check
// Starts AiN: from this package when it is a platform package installed by name, else from the one
// npm/bun picked among the optional dependencies.
//
//   ain [args…]               starts the app (refuses when an installer already put AiN on this machine)
//   ain uninstall [--purge]   removes launching at login (and with --purge the settings and models),
//                             then this package: npm and bun run nothing on removal themselves
import { spawn, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

const require = createRequire(import.meta.url);
const platform = `@satcomx00/ain-${process.platform}-${process.arch}`;
const manifest = require.resolve("../package.json");

/** @param {string} message @returns {never} */
const fail = (message) => {
  console.error(`ain: ${message}`);
  process.exit(1);
};

/** The `executable` a package's manifest names, as an absolute path, if it names one. @param {string} path */
const named = (path) => {
  /** @type {{ executable?: unknown }} */
  const { executable } = require(path);
  return typeof executable === "string" ? join(dirname(path), executable) : undefined;
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
const executable = () => named(manifest) ?? named(platformManifest()) ?? fail(`${platform} names no executable.`);

/** Some package managers drop the executable bit: put it back. @param {string} path */
const ensureExecutable = (path) => {
  if (process.platform === "win32") return;
  try {
    accessSync(path, constants.X_OK);
  } catch {
    chmodSync(path, 0o755);
  }
};

/** Where AiN's installers put it: NSIS and MSI, the .dmg's usual targets, the .deb and .rpm. */
const installerPaths = () => {
  const { LOCALAPPDATA, ProgramFiles } = process.env;
  switch (process.platform) {
    case "win32":
      return [LOCALAPPDATA, ProgramFiles].filter((d) => d !== undefined).map((d) => join(d, "AiN", "AiN.exe"));
    case "darwin":
      return ["/Applications/AiN.app", join(homedir(), "Applications", "AiN.app")];
    default:
      return ["/usr/bin/ain", "/usr/bin/AiN"];
  }
};

/** The package manager command that removes this package, from where it is installed. */
const removal = () => {
  /** @type {{ name: string }} */
  const { name } = require(manifest);
  const root = dirname(manifest);
  if (root.includes(`${sep}.bun${sep}`)) return ["bun", "remove", "--global", name];
  // npm: <prefix>/lib/node_modules/<name> (<prefix>/node_modules/<name> on Windows).
  let prefix = root.slice(0, root.lastIndexOf(`${sep}node_modules${sep}`));
  if (basename(prefix) === "lib" && process.platform !== "win32") prefix = dirname(prefix);
  return ["npm", "rm", "--global", "--prefix", prefix, name];
};

/** @param {string} app @param {readonly string[]} args */
const uninstall = (app, args) => {
  const cleanup = spawnSync(app, ["--cleanup", ...args.filter((a) => a === "--purge")], { stdio: "inherit" });
  if (cleanup.status !== 0) fail(`cleanup failed (${cleanup.error?.message ?? `exit ${cleanup.status}`}): nothing was uninstalled.`);
  const [command = "npm", ...rest] = removal();
  // Windows runs npm/bun through their .cmd shims, hence a shell, which needs paths quoted.
  const shell = process.platform === "win32";
  const removed = spawnSync(command, shell ? rest.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : rest, {
    stdio: "inherit",
    shell,
  });
  if (removed.status !== 0) fail(`couldn't remove the package; run: ${[command, ...rest].join(" ")}`);
};

/** @param {string} app @param {readonly string[]} args */
const start = (app, args) => {
  const installed = installerPaths().find((p) => existsSync(p));
  if (installed) {
    fail(
      `AiN is already installed at ${installed}. Two copies share their settings and launching at login:\n` +
        "keep one. To remove this one: ain uninstall",
    );
  }
  // A desktop app: detached, so the terminal is free again and closing it leaves the app running.
  spawn(app, args, { detached: true, stdio: "ignore" })
    .on("error", (e) => fail(`could not start ${app}: ${e.message}`))
    .unref();
};

const app = executable();
ensureExecutable(app);
const [command, ...args] = process.argv.slice(2);
if (command === "uninstall") uninstall(app, args);
else start(app, process.argv.slice(2));
