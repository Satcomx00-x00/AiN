/**
 * Where the VM tests run: the Proxmox host, and one test VM per Fedora desktop, each a linked clone
 * of a template prepared for AiN (see README.md).
 */

export interface Target {
  /** Short name: the results folder, the log prefix, and what `--targets` picks by. */
  readonly name: string;
  /** The template the test VM is cloned from; 0 for a VM that already exists (`direct`). */
  readonly template: number;
  /** The test VM. Created on the first run, then kept between runs; `--fresh` recreates it. */
  readonly vmid: number;
  /**
   * A VM that already exists and is managed by hand (a dev desktop): never cloned, recreated or
   * shut down by the runner, and its stored app state is backed up and restored around the run.
   */
  readonly direct?: boolean;
  /** The desktop user to log in as over SSH. Defaults to GUEST_USER. */
  readonly user?: string;
  /** For a direct VM: its address, when DHCP or the guest agent shouldn't decide it. */
  readonly address?: string;
}

export const TARGETS: readonly Target[] = [
  { name: "f43", template: 9002, vmid: 412 },
  { name: "f44", template: 9003, vmid: 413 },
  // The Fedora 44 Workstation dev desktop at 192.168.1.181 (Proxmox 207): a real, long-lived
  // machine, tested in place. Its app state is backed up and restored, and it is never destroyed.
  { name: "f44dev", template: 0, vmid: 207, direct: true, address: "192.168.1.181", user: "satcom" },
];

export const PROXMOX = {
  host: process.env.PVE_HOST ?? "192.168.1.100",
  node: process.env.PVE_NODE ?? "pve",
};

/** The desktop's user in the templates: auto-login, passwordless sudo, our SSH keys. */
export const GUEST_USER = "fedora";

/** Proxmox tag on the VMs this runner created: the only ones `--fresh` will delete. */
export const VM_TAG = "vmtest";

/** CMake for the guests, which can't install packages (no internet): opus builds libopus with it. */
export const CMAKE_VERSION = "4.4.4";
