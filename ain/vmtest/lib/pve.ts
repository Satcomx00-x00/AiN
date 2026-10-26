import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, sleep } from "./proc.ts";

export interface Vm {
  readonly vmid: number;
  readonly name?: string;
  readonly status: string;
  readonly tags?: string;
}

/**
 * The API token: `PVE_TOKEN` (`user@realm!name=secret`), or the one the Proxmox MCP server is set up
 * with (`PVE_CONFIG`, by default ~/.config/proxmox-mcp/config.json).
 */
export function loadToken(): string {
  if (process.env.PVE_TOKEN) return process.env.PVE_TOKEN;
  const file = process.env.PVE_CONFIG ?? join(homedir(), ".config", "proxmox-mcp", "config.json");
  const { auth } = JSON.parse(readFileSync(file, "utf8")) as {
    auth: { user: string; token_name: string; token_value: string };
  };
  return `${auth.user}!${auth.token_name}=${auth.token_value}`;
}

/**
 * The cluster's root CA, which signs the API's certificate: `PVE_CA` (a PEM file), or read from the
 * host over SSH as root (the SSH host key vouches for it).
 */
export async function loadCa(host: string): Promise<string> {
  if (process.env.PVE_CA) return readFileSync(process.env.PVE_CA, "utf8");
  const r = await run("ssh", ["-o", "BatchMode=yes", `root@${host}`, "cat /etc/pve/pve-root-ca.pem"]);
  if (r.code !== 0) throw new Error(`can't read the Proxmox root CA over SSH (set PVE_CA): ${r.stderr.trim()}`);
  return r.stdout.toString("utf8");
}

/** The Proxmox API, plus `qm` over SSH as root for what the API lacks (screenshots). */
export class Pve {
  readonly host: string;
  readonly node: string;
  readonly #token: string;
  readonly #ca: string;

  constructor(host: string, node: string, token: string, ca: string) {
    this.host = host;
    this.node = node;
    this.#token = token;
    this.#ca = ca;
  }

  api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params: Record<string, string | number> = {}): Promise<T> {
    const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const inQuery = method === "GET" || method === "DELETE";
    const headers: Record<string, string | number> = { Authorization: `PVEAPIToken=${this.#token}` };
    if (!inQuery && body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: this.host,
          port: 8006,
          method,
          path: `/api2/json${path}${inQuery && body ? `?${body}` : ""}`,
          headers,
          ca: this.#ca,
        },
        (res) => {
          let text = "";
          res.on("data", (c: Buffer) => (text += c.toString("utf8")));
          res.on("end", () => {
            if ((res.statusCode ?? 500) >= 400) reject(new Error(`${method} ${path}: ${res.statusCode} ${res.statusMessage} ${text}`));
            else resolve((JSON.parse(text) as { data: T }).data);
          });
        },
      );
      req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${path}: timed out`)));
      req.on("error", reject);
      req.end(inQuery ? undefined : body);
    });
  }

  async vm(vmid: number): Promise<Vm | undefined> {
    const all = await this.api<(Vm & { type: string })[]>("GET", "/cluster/resources", { type: "vm" });
    return all.find((v) => v.vmid === vmid);
  }

  /** Waits for a task (a UPID, as clone, start, stop and delete return) and throws if it failed. */
  async wait(upid: string, timeoutMs = 600_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const s = await this.api<{ status: string; exitstatus?: string }>(
        "GET",
        `/nodes/${this.node}/tasks/${encodeURIComponent(upid)}/status`,
      );
      if (s.status === "stopped") {
        if (s.exitstatus !== "OK") throw new Error(`task ${upid} failed: ${s.exitstatus}`);
        return;
      }
      await sleep(2000);
    }
    throw new Error(`task ${upid} still running after ${timeoutMs / 1000}s`);
  }

  async qemu(method: "GET" | "POST" | "PUT" | "DELETE", vmid: number, path: string, params?: Record<string, string | number>) {
    return this.api<string>(method, `/nodes/${this.node}/qemu/${vmid}${path}`, params);
  }

  /** A linked clone: instant on the ZFS store, and it shares the template's disk until it writes. */
  async clone(template: number, vmid: number, name: string): Promise<void> {
    await this.wait(await this.qemu("POST", template, "/clone", { newid: vmid, name, full: 0 }));
  }

  async start(vmid: number): Promise<void> {
    await this.wait(await this.qemu("POST", vmid, "/status/start"));
  }

  async shutdown(vmid: number): Promise<void> {
    await this.wait(await this.qemu("POST", vmid, "/status/shutdown", { timeout: 120, forceStop: 1 }));
  }

  async destroy(vmid: number): Promise<void> {
    const vm = await this.vm(vmid);
    if (vm?.status === "running") await this.wait(await this.qemu("POST", vmid, "/status/stop"));
    await this.wait(await this.qemu("DELETE", vmid, "", { purge: 1, "destroy-unreferenced-disks": 1 }));
  }

  async sendKey(vmid: number, key: string): Promise<void> {
    await this.qemu("PUT", vmid, "/sendkey", { key });
  }

  /** The guest's IPv4 address, from its guest agent; undefined while the agent isn't up yet. */
  async ip(vmid: number): Promise<string | undefined> {
    type Iface = { name: string; "ip-addresses"?: { "ip-address-type": string; "ip-address": string }[] };
    try {
      const { result } = await this.api<{ result: Iface[] }>("GET", `/nodes/${this.node}/qemu/${vmid}/agent/network-get-interfaces`);
      for (const iface of result) {
        if (iface.name === "lo") continue;
        const a = iface["ip-addresses"]?.find((a) => a["ip-address-type"] === "ipv4");
        if (a) return a["ip-address"];
      }
    } catch {
      // The agent isn't running yet.
    }
    return undefined;
  }

  /** Saves the VM's screen as a PNG: QEMU's own framebuffer, whatever the desktop allows. */
  async screenshot(vmid: number, file: string): Promise<void> {
    const tmp = `/tmp/vmtest-${vmid}.png`;
    const r = await run("ssh", [
      "-o",
      "BatchMode=yes",
      `root@${this.host}`,
      `echo 'screendump ${tmp} -f png' | qm monitor ${vmid} >/dev/null && cat ${tmp} && rm -f ${tmp}`,
    ]);
    if (r.code !== 0 || r.stdout.length === 0) throw new Error(`screenshot of ${vmid} failed: ${r.stderr.trim()}`);
    writeFileSync(file, r.stdout);
  }
}
