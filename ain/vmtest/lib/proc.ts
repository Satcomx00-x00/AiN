import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface Result {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Written to stdin, then closed: bytes, or another process's output. */
  readonly input?: string | Buffer | Readable;
  /** Each line of output, stdout and stderr, as it comes. Keeps stdin open for the caller to write to. */
  readonly onLine?: (line: string, child: ChildProcess) => void;
}

/** Runs a program to the end. Never throws on a failing exit code: callers decide (see `check`). */
export function run(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const stdin = opts.input !== undefined || opts.onLine ? "pipe" : "ignore";
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: [stdin, "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const lines = (chunk: Buffer, rest: { s: string }) => {
      if (!opts.onLine) return;
      rest.s += chunk.toString("utf8");
      const parts = rest.s.split("\n");
      rest.s = parts.pop() ?? "";
      for (const p of parts) opts.onLine(p.replace(/\r$/, ""), child);
    };
    const restOut = { s: "" };
    const restErr = { s: "" };
    child.stdout!.on("data", (c: Buffer) => {
      out.push(c);
      lines(c, restOut);
    });
    child.stderr!.on("data", (c: Buffer) => {
      err += c.toString("utf8");
      lines(c, restErr);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      for (const rest of [restOut, restErr]) if (rest.s && opts.onLine) opts.onLine(rest.s, child);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err });
    });
    // A closed pipe on the other side (ssh gone) is reported by the exit code, not as a crash.
    child.stdin?.on("error", () => {});
    if (typeof opts.input === "string" || Buffer.isBuffer(opts.input)) child.stdin?.end(opts.input);
    else if (opts.input) opts.input.pipe(child.stdin!);
  });
}

/** Runs a program and returns its output; throws with its stderr if it fails. */
export async function check(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.code}\n${r.stderr.trim()}`);
  return r.stdout.toString("utf8");
}

/** `producer | consumer`: throws if either fails. */
export async function pipe(
  producer: readonly [string, readonly string[], RunOptions?],
  consumer: readonly [string, readonly string[], RunOptions?],
): Promise<string> {
  const [pcmd, pargs, popts = {}] = producer;
  const child = spawn(pcmd, pargs, { cwd: popts.cwd, env: popts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  let perr = "";
  child.stderr.on("data", (c: Buffer) => (perr += c.toString("utf8")));
  const pdone = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  const [ccmd, cargs, copts = {}] = consumer;
  const out = check(ccmd, cargs, { ...copts, input: child.stdout });
  const pcode = await pdone;
  if (pcode !== 0) throw new Error(`${pcmd} ${pargs.join(" ")} exited with ${pcode}\n${perr.trim()}`);
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
