import { createReadStream, writeFileSync } from "node:fs";
import { GUEST_USER } from "../targets.ts";
import { pipe, type Result, type RunOptions, run, sleep } from "./proc.ts";

/** A test VM over SSH, as the desktop's user. */
export class Guest {
  readonly ip: string;
  readonly #ssh: readonly string[];

  /**
   * `knownHosts`: this target's own file, emptied here. Clones regenerate their host keys, often on
   * an address a previous clone had: the key is learnt on first contact, then held for the run.
   */
  constructor(ip: string, knownHosts: string) {
    this.ip = ip;
    writeFileSync(knownHosts, "");
    this.#ssh = [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${knownHosts}`,
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "LogLevel=ERROR",
      `${GUEST_USER}@${ip}`,
    ];
  }

  /** Runs a remote command line. */
  exec(command: string, opts: RunOptions = {}): Promise<Result> {
    return run("ssh", [...this.#ssh, command], opts);
  }

  /** A local tar of `files` (paths relative to `dir`, or a file listing them) unpacked into `remoteDir`. */
  async send(dir: string, files: readonly string[] | { list: string }, remoteDir: string, exclude: readonly string[] = []): Promise<void> {
    const which = "list" in files ? ["-T", files.list] : files;
    const tar = ["-cf", "-", ...exclude.map((e) => `--exclude=${e}`), ...which];
    await pipe(["tar", tar, { cwd: dir }], ["ssh", [...this.#ssh, `mkdir -p ${remoteDir} && tar -xf - -C ${remoteDir}`]]);
  }

  /** Runs a bash script, sent on stdin: no quoting to get right. */
  sh(script: string): Promise<Result> {
    return this.exec("bash -s", { input: script });
  }

  /** Like `sh`, but throws if the script fails; returns its output. */
  async ok(script: string, what = "remote script"): Promise<string> {
    const r = await this.sh(script);
    if (r.code !== 0) throw new Error(`${what} failed (${r.code}) on ${this.ip}\n${(r.stdout.toString() + r.stderr).trim().slice(-2000)}`);
    return r.stdout.toString("utf8");
  }

  async upload(local: string, remote: string): Promise<void> {
    const r = await this.exec(`cat > '${remote}'`, { input: createReadStream(local) });
    if (r.code !== 0) throw new Error(`upload to ${this.ip}:${remote} failed: ${r.stderr.trim()}`);
  }

  async waitSsh(timeoutMs = 180_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < end) {
      const r = await this.exec("true");
      if (r.code === 0) return;
      last = r.stderr.trim();
      await sleep(3000);
    }
    throw new Error(`no SSH on ${this.ip} after ${timeoutMs / 1000}s: ${last}`);
  }
}
