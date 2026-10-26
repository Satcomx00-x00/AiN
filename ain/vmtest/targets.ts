/**
 * Where the VM tests run: the Proxmox host, and one test VM per Fedora desktop, each a linked clone
 * of a template prepared for AiN (see README.md).
 */

export interface Target {
  /** Short name: the results folder, the log prefix, and what `--targets` picks by. */
  readonly name: string;
  /** The template the test VM is cloned from. */
  readonly template: number;
  /** The test VM. Created on the first run, then kept between runs; `--fresh` recreates it. */
  readonly vmid: number;
}

export const TARGETS: readonly Target[] = [
  { name: "f43", template: 9002, vmid: 412 },
  { name: "f44", template: 9003, vmid: 413 },
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
