#!/usr/bin/env node
// @ts-check
/**
 * Stages one of AiN's npm packages in a folder, for `npm pack <folder>`:
 *
 *   node npm/stage.mjs <linux-x64|darwin-x64|win32-x64> <version> <release dir> <out>
 *   node npm/stage.mjs launcher <version> <out>
 *
 * A platform's package holds what `tauri build` left in the release dir
 * (`src-tauri/target/[<triple>/]release`): the AppImage, the .app or the .exe. The launcher
 * (`ain-app`) pins every platform's package at its own version, as optional dependencies.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHER, PLATFORMS, packageName } from "./ain-app/lib/target.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_DIR = join(HERE, LAUNCHER);
const LICENSE = join(HERE, "..", "LICENSE");

/** @typedef {Record<string, unknown> & { name: string, version: string }} Manifest */

/** @returns {Manifest} */
export const baseManifest = () => JSON.parse(readFileSync(join(LAUNCHER_DIR, "package.json"), "utf8"));

/**
 * The launcher's package.json at `version`, every platform's package pinned to it.
 * @param {Manifest} base
 * @param {string} version
 * @returns {Manifest}
 */
export const launcherManifest = (base, version) => ({
  ...base,
  version,
  optionalDependencies: Object.fromEntries(Object.keys(PLATFORMS).map((id) => [packageName(id), version])),
});

/**
 * A platform package's package.json: only installed where its `os`, `cpu` (and `libc`) match.
 * @param {Manifest} base
 * @param {string} id
 * @param {string} version
 * @returns {Manifest}
 */
export const platformManifest = (base, id, version) => {
  const platform = PLATFORMS[id];
  if (!platform) throw new Error(`unknown platform ${id}`);
  return {
    name: packageName(id),
    version,
    description: platform.description,
    homepage: base.homepage,
    bugs: base.bugs,
    repository: base.repository,
    license: base.license,
    os: [platform.os],
    cpu: platform.cpu,
    ...(platform.libc ? { libc: platform.libc } : {}),
    files: [platform.file],
    // Yarn OnP: keep it a real folder on disk, where the launcher can start it.
    preferUnplugged: true,
  };
};

/**
 * The one file of `dir` ending in `extension`, or among several the one for `version`.
 * @param {string} dir
 * @param {string} extension
 * @param {string} version
 */
const pick = (dir, extension, version) => {
  const found = readdirSync(dir).filter((f) => f.endsWith(extension));
  const chosen = found.length === 1 ? found : found.filter((f) => f.includes(`_${version}_`));
  if (chosen.length !== 1) throw new Error(`expected one ${extension} for ${version} in ${dir}, found: ${found.join(", ") || "none"}`);
  return join(dir, /** @type {string} */ (chosen[0]));
};

/**
 * Where `tauri build` leaves each platform's app, under its release dir.
 * @type {Readonly<Record<string, (release: string, version: string) => string>>}
 */
export const ARTIFACTS = Object.freeze({
  "linux-x64": (release, version) => pick(join(release, "bundle", "appimage"), ".AppImage", version),
  "darwin-x64": (release) => join(release, "bundle", "macos", "AiN.app"),
  "win32-x64": (release) => join(release, "ain.exe"),
});

/** @param {string} out */
const fresh = (out) => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
};

/** @param {string} out @param {Manifest} manifest */
const finish = (out, manifest) => {
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(LICENSE, join(out, "LICENSE"));
};

/**
 * Stages the launcher in `out`.
 * @param {string} version
 * @param {string} out
 */
export const stageLauncher = (version, out) => {
  fresh(out);
  for (const entry of ["bin", "lib", "README.md"]) {
    cpSync(join(LAUNCHER_DIR, entry), join(out, entry), { recursive: true });
  }
  finish(out, launcherManifest(baseManifest(), version));
};

/**
 * Stages platform `id`'s package in `out`, from its build in `release`.
 * @param {string} id
 * @param {string} version
 * @param {string} release
 * @param {string} out
 */
export const stagePlatform = (id, version, release, out) => {
  const platform = PLATFORMS[id];
  const locate = ARTIFACTS[id];
  if (!platform || !locate) throw new Error(`unknown platform ${id}: one of ${Object.keys(PLATFORMS).join(", ")}`);
  const artifact = locate(release, version);
  if (!existsSync(artifact)) throw new Error(`no build at ${artifact}`);
  fresh(out);
  // Modes kept: the AppImage and the .app's program stay executable, and npm keeps them so.
  cpSync(artifact, join(out, platform.file), { recursive: true });
  const base = baseManifest();
  writeFileSync(
    join(out, "README.md"),
    `# ${packageName(id)}\n\n${platform.description}, installed by [\`${LAUNCHER}\`](https://www.npmjs.com/package/${LAUNCHER}): install that one.\n`,
  );
  finish(out, platformManifest(base, id, version));
};

/** @param {string[]} argv */
const main = ([target, version, ...rest]) => {
  const usage = "usage: stage.mjs <platform> <version> <release dir> <out> | stage.mjs launcher <version> <out>";
  if (!target || !version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(usage);
  if (target === "launcher") {
    const [out] = rest;
    if (!out) throw new Error(usage);
    stageLauncher(version, out);
  } else {
    const [release, out] = rest;
    if (!release || !out) throw new Error(usage);
    stagePlatform(target, version, release, out);
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`stage.mjs: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
