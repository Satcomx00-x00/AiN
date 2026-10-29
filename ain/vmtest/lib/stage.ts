/**
 * What the guests need from this machine, since they have no internet: the source of the revision
 * under test with its frontend and sherpa-onnx's libraries, the crates it depends on, and the tools
 * its build would otherwise download. Each is made once and cached in vmtest/.cache.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CMAKE_VERSION } from "../targets.ts";
import { check, run } from "./proc.ts";

export interface Rev {
  /** The commit tested: HEAD, or a commit of the working tree's tracked changes made by `git stash create`. */
  readonly sha: string;
  readonly label: string;
}

export interface Stage {
  readonly rev: Rev;
  /** The app's folder (the repository's `ain`), checked out at the revision, with `dist` built. */
  readonly app: string;
}

export interface Vendor {
  readonly dir: string;
  /** Each crate folder's checksum, to send a guest only the crates it lacks. */
  readonly crates: ReadonlyMap<string, string>;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export class Host {
  /** The app's folder in this checkout (holding vmtest/). */
  readonly app: string;
  readonly cache: string;

  constructor(app: string) {
    this.app = app;
    this.cache = join(app, "vmtest", ".cache");
    mkdirSync(this.cache, { recursive: true });
  }

  git(args: readonly string[]): Promise<string> {
    return check("git", ["-C", this.app, ...args]).then((s) => s.trim());
  }

  /** `ref`, or by default the working tree as it is (tracked files: untracked ones aren't sent). */
  async resolve(ref?: string): Promise<Rev> {
    if (ref) return { sha: await this.git(["rev-parse", "--verify", `${ref}^{commit}`]), label: ref };
    const head = await this.git(["rev-parse", "HEAD"]);
    // Writes a commit object only: the stash list, shared with other worktrees, is left alone.
    const dirty = await this.git(["stash", "create", "vmtest"]);
    if (dirty) return { sha: dirty, label: `working tree (on ${head.slice(0, 9)})` };
    return { sha: head, label: `HEAD (${head.slice(0, 9)})` };
  }

  /**
   * A detached worktree at the revision, with its dependencies installed (sherpa-onnx's libraries
   * too) and `dist` built: the guests build only the Rust side, so they need neither Node nor the
   * network.
   */
  async stage(rev: Rev, log: (s: string) => void): Promise<Stage> {
    const root = join(this.cache, "stage", rev.sha.slice(0, 12));
    const prefix = await this.git(["rev-parse", "--show-prefix"]);
    const app = join(root, prefix);
    if (existsSync(join(app, "dist", "index.html"))) return { rev, app };

    log(`staging ${rev.label}: worktree, bun install, sherpa-onnx's libraries, vite build`);
    if (existsSync(root)) await this.git(["worktree", "remove", "--force", root]);
    await this.git(["worktree", "add", "--force", "--detach", root, rev.sha]);
    await check("bun", ["install", "--frozen-lockfile"], { cwd: app });
    await check("bun", ["run", "native"], { cwd: app });
    await check("bun", ["run", "build"], { cwd: app });
    await this.prune("stage", 3, (dir) => this.git(["worktree", "remove", "--force", dir]).then(() => {}));
    return { rev, app };
  }

  /** The crates of the stage's Cargo.lock, vendored: one folder per lockfile. */
  async vendor(stage: Stage, log: (s: string) => void): Promise<Vendor> {
    const tauri = join(stage.app, "src-tauri");
    const dir = join(this.cache, "vendor", sha256(readFileSync(join(tauri, "Cargo.lock"))).slice(0, 12));
    if (!existsSync(join(dir, ".complete"))) {
      log("vendoring the crates (once per Cargo.lock)");
      rmSync(dir, { recursive: true, force: true });
      await check("cargo", ["vendor", "--locked", "--quiet", "--manifest-path", join(tauri, "Cargo.toml"), dir]);
      writeFileSync(join(dir, ".complete"), "");
      await this.prune("vendor", 2, async (d) => rmSync(d, { recursive: true, force: true }));
    }
    const crates = new Map<string, string>();
    for (const name of readdirSync(dir)) {
      const sum = join(dir, name, ".cargo-checksum.json");
      if (existsSync(sum)) crates.set(name, crateSum(readFileSync(sum)));
    }
    return { dir, crates };
  }

  /** CMake's Linux build from Kitware's release, checked against its published SHA-256. */
  cmake(): Promise<string> {
    const name = `cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz`;
    const base = `https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}`;
    return this.#once(name, async () => {
      const sums = (await download(`${base}/cmake-${CMAKE_VERSION}-SHA-256.txt`)).toString("utf8");
      const want = sums.split("\n").find((l) => l.trim().endsWith(` ${name}`))?.split(/\s+/)[0];
      const data = await download(`${base}/${name}`);
      if (!want || sha256(data) !== want) throw new Error(`${name}: checksum mismatch`);
      return data;
    });
  }

  readonly #fetching = new Map<string, Promise<string>>();

  /** The cached file `name` in .cache/fetch, made by `get` once: targets asking together share it. */
  #once(name: string, get: () => Promise<Buffer>): Promise<string> {
    const file = join(this.cache, "fetch", name);
    if (existsSync(file)) return Promise.resolve(file);
    let pending = this.#fetching.get(name);
    if (!pending) {
      pending = get().then((data) => {
        mkdirSync(join(this.cache, "fetch"), { recursive: true });
        writeFileSync(file, data);
        return file;
      });
      pending.catch(() => this.#fetching.delete(name));
      this.#fetching.set(name, pending);
    }
    return pending;
  }

  /** Keeps the `keep` most recent entries of a cache folder. */
  async prune(kind: string, keep: number, remove: (dir: string) => Promise<void>): Promise<void> {
    const dir = join(this.cache, kind);
    const entries = readdirSync(dir)
      .map((n) => join(dir, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const old of entries.slice(keep)) await remove(old);
  }
}

/**
 * A vendored crate's identity: the package checksum from .cargo-checksum.json, or for a git
 * dependency (which has none) the file's own hash. guest/vendor-sums.py computes the same.
 */
export function crateSum(checksumJson: Buffer): string {
  const pkg = (JSON.parse(checksumJson.toString("utf8")) as { package?: string | null }).package;
  return pkg ?? sha256(checksumJson);
}

async function download(url: string, tries = 3): Promise<Buffer> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      const why = e instanceof Error ? (e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message) : String(e);
      if (i >= tries) throw new Error(`GET ${url}: ${why}`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

/** The tools this machine lacks, of those the runner calls. */
export async function missingTools(): Promise<string[]> {
  const missing: string[] = [];
  for (const [tool, flag] of [["git", "--version"], ["cargo", "--version"], ["bun", "--version"], ["ssh", "-V"], ["tar", "--version"]] as const) {
    const r = await run(tool, [flag]).catch(() => ({ code: 1 }));
    if (r.code !== 0) missing.push(tool);
  }
  return missing;
}
