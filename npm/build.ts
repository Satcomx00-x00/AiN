#!/usr/bin/env bun
// Builds the npm packages from the release's binaries: one per platform, plus `@satcomx00/ain`, whose
// optional dependencies let npm/bun install only the one matching the machine. Each platform package
// also works on its own (`bun i -g @satcomx00/ain-<platform>`): it carries the same `ain` launcher.
//
//   bun build.ts <version> <binaries> <out>
//
// <binaries>/<platform>/ holds what release.yml staged for that platform (see `PLATFORMS`); missing
// platforms are skipped. Writes <out>/<package>/ for each package and prints their folders, the
// main package last: publish them in that order, so it never points at a version that isn't out.
import { access, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCOPE = "@satcomx00";
const MAIN = join(import.meta.dir, "ain");

interface Platform {
  readonly os: NodeJS.Platform;
  readonly cpu: NodeJS.Architecture;
  /** The file to launch, relative to the staged folder. */
  readonly executable: (staged: string) => Promise<string>;
  /** Installed by `@satcomx00/ain` on matching machines; otherwise only when asked for by name. */
  readonly automatic: boolean;
  readonly description: string;
}

/** macOS: the `.app` bundle, launched through the executable its Info.plist names. */
const macApp = async (staged: string): Promise<string> => {
  const app = (await readdir(staged)).find((f) => f.endsWith(".app"));
  if (!app) throw new Error(`no .app in ${staged}`);
  const plist = await readFile(join(staged, app, "Contents", "Info.plist"), "utf8");
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!name) throw new Error(`${app} has no CFBundleExecutable`);
  return `${app}/Contents/MacOS/${name}`;
};

const fedora = (release: number): Platform => ({
  os: "linux",
  cpu: "x64",
  executable: async () => "ain",
  automatic: false,
  description: `AiN for Fedora ${release} x64, using the system's WebKitGTK (see the README for the dnf line).`,
});

const PLATFORMS = {
  "win32-x64": {
    os: "win32",
    cpu: "x64",
    executable: async () => "ain.exe",
    automatic: true,
    description: "AiN for Windows x64.",
  },
  "darwin-x64": {
    os: "darwin",
    cpu: "x64",
    executable: macApp,
    automatic: true,
    description: "AiN for macOS x64.",
  },
  // The AppImage carries WebKitGTK and the rest: it runs on any distro.
  "linux-x64": {
    os: "linux",
    cpu: "x64",
    executable: async () => "AiN.AppImage",
    automatic: true,
    description: "AiN for Linux x64, as an AppImage (any distro).",
  },
  // Built on each Fedora against its own libraries. npm can't tell distros apart, so never automatic.
  fedora43: fedora(43),
  fedora44: fedora(44),
} as const satisfies Record<string, Platform>;

type PlatformId = keyof typeof PLATFORMS;

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly repository: { readonly type: string; readonly url: string; readonly directory: string };
  readonly [field: string]: unknown;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const exists = (path: string) => access(path).then(() => true, () => false);

/** The launcher and the README, which every package carries. */
const copyCommon = async (dir: string) => {
  await cp(join(MAIN, "bin"), join(dir, "bin"), { recursive: true });
  await cp(join(import.meta.dir, "README.md"), join(dir, "README.md"));
};

const main = async ([version, binaries, out]: readonly (string | undefined)[]) => {
  if (!version || !binaries || !out) throw new Error("usage: bun build.ts <version> <binaries> <out>");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);

  const base: Manifest = JSON.parse(await readFile(join(MAIN, "package.json"), "utf8"));
  // What the platform packages share with the main one: license, links, keywords, engines.
  const { name: _name, version: _version, bin, files: _files, optionalDependencies: _deps, ...shared } = base;
  await rm(out, { recursive: true, force: true });

  const built: { readonly id: PlatformId; readonly dir: string; readonly automatic: boolean }[] = [];
  for (const [id, platform] of Object.entries(PLATFORMS) as [PlatformId, Platform][]) {
    const { os, cpu, executable, automatic, description } = platform;
    const staged = join(binaries, id);
    if (!(await exists(staged))) {
      console.error(`skipped ${id}: nothing in ${staged}`);
      continue;
    }
    const exe = await executable(staged);
    if (!(await exists(join(staged, exe)))) throw new Error(`${id}: ${exe} is missing`);

    const dir = join(out, `ain-${id}`);
    await cp(staged, dir, { recursive: true, verbatimSymlinks: true });
    await copyCommon(dir);
    const manifest = {
      name: `${SCOPE}/ain-${id}`,
      version,
      ...shared,
      description,
      repository: { ...base.repository, directory: "npm" },
      bin,
      os: [os],
      cpu: [cpu],
      executable: exe,
      preferUnplugged: true,
    };
    await writeFile(join(dir, "package.json"), json(manifest));
    built.push({ id, dir, automatic });
  }
  if (built.length === 0) throw new Error(`no binaries under ${binaries}`);

  const dir = join(out, "ain");
  await mkdir(dir, { recursive: true });
  await copyCommon(dir);
  const platforms = Object.fromEntries(
    built.filter((b) => b.automatic).map(({ id }) => [`${SCOPE}/ain-${id}`, version]),
  );
  await writeFile(join(dir, "package.json"), json({ ...base, version, optionalDependencies: platforms }));

  console.log([...built.map((b) => b.dir), dir].join("\n"));
};

await main(Bun.argv.slice(2));
