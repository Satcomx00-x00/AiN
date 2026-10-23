// @ts-check
/**
 * The builds AiN ships on npm: one package per OS, holding what the release built for it. npm
 * installs only the one whose `os` and `cpu` match (they are optional dependencies of `ain-app`),
 * and the launcher starts it.
 */
import { join } from "node:path";

export const LAUNCHER = "ain-app";

/**
 * @typedef {object} Platform
 * @property {NodeJS.Platform} os
 * @property {string[]} cpu
 * @property {string[]} [libc]
 * @property {string} file What the package holds: the app, as the release built it.
 * @property {string} executable The program to start, or that must stay executable, inside `file`.
 * @property {string} description
 */

/** @type {Readonly<Record<string, Platform>>} */
export const PLATFORMS = Object.freeze({
  // The AppImage carries its own WebKitGTK and GTK: nothing to install on the system.
  "linux-x64": {
    os: "linux",
    cpu: ["x64"],
    libc: ["glibc"],
    file: "AiN.AppImage",
    executable: "AiN.AppImage",
    description: "AiN for Linux x64 (AppImage)",
  },
  // A whole .app, so macOS reads its Info.plist and asks for permissions in AiN's name. Apple
  // silicon runs it through Rosetta.
  "darwin-x64": {
    os: "darwin",
    cpu: ["x64", "arm64"],
    file: "AiN.app",
    executable: "AiN.app/Contents/MacOS/ain",
    description: "AiN for macOS (Intel build, Rosetta on Apple silicon)",
  },
  "win32-x64": {
    os: "win32",
    cpu: ["x64"],
    file: "ain.exe",
    executable: "ain.exe",
    description: "AiN for Windows x64",
  },
});

/** @param {string} id */
export const packageName = (id) => `${LAUNCHER}-${id}`;

/**
 * The build for an OS and CPU (`process.platform`, `process.arch`), if there is one.
 * @param {string} platform
 * @param {string} arch
 * @returns {string | undefined}
 */
export const platformFor = (platform, arch) =>
  Object.entries(PLATFORMS).find(([, p]) => p.os === platform && p.cpu.includes(arch))?.[0];

/**
 * @typedef {object} Command
 * @property {string} file
 * @property {string[]} args
 * @property {Record<string, string>} env Added to the launcher's environment.
 * @property {string} executable Must be executable for the command to work.
 */

/**
 * How to start a build installed in `dir`, passing it `args`.
 * @param {string} id
 * @param {string} dir
 * @param {readonly string[]} args
 * @param {{ fuse: boolean, wait: boolean }} host `fuse`: whether the AppImage can mount itself (if
 *   not, it unpacks itself); `wait`: the command returns only when AiN quits.
 * @returns {Command}
 */
export const command = (id, dir, args, { fuse, wait }) => {
  const platform = PLATFORMS[id];
  if (!platform) throw new Error(`no AiN build for ${id}`);
  const executable = join(dir, platform.executable);
  switch (platform.os) {
    // Through Launch Services, as a double-click would: AiN is then its own app for macOS, not a
    // child of the terminal, and the permissions it asks for are its own.
    case "darwin":
      return {
        file: "open",
        args: [...(wait ? ["-W"] : []), join(dir, platform.file), ...(args.length ? ["--args", ...args] : [])],
        env: {},
        executable,
      };
    case "linux":
      return { file: executable, args: [...args], env: fuse ? {} : { APPIMAGE_EXTRACT_AND_RUN: "1" }, executable };
    default:
      return { file: executable, args: [...args], env: {}, executable };
  }
};
