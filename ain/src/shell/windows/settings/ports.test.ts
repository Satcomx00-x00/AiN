// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { appPorts, settingsPorts, usePorts } = await import("./ports");
const { idlePopup, tauriPopup } = await import("../../commands");
const { importSource, noExtensions, tauriExtensions } = await import("../../extensions");
const { noCommunity, tauriCommunity } = await import("../../community");
const { tauriSettings } = await import("../../settings");
const { tauriUpdater } = await import("../../updater");

afterEach(() => {
  usePorts(undefined);
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("the settings page's ports", () => {
  it("are in-memory stand-ins in the browser", () => {
    const ports = appPorts();
    expect(ports.inApp).toBe(false);
    expect([ports.popup, ports.folder, ports.importer]).toEqual([idlePopup, noExtensions, importSource]);
    expect(ports.store).not.toBe(tauriSettings);
    expect(ports.community).toBe(noCommunity);
    expect(ports.updater).not.toBe(tauriUpdater);
  });

  it("are the app's backend inside Tauri", () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    const ports = appPorts();
    expect([ports.inApp, ports.store, ports.popup, ports.folder, ports.community, ports.updater]).toEqual([true, tauriSettings, tauriPopup, tauriExtensions, tauriCommunity, tauriUpdater]);
  });

  it("can be replaced, e.g. by an integration test, and given back", () => {
    const given = { ...appPorts(), inApp: false };
    usePorts(given);
    expect(settingsPorts()).toBe(given);
    usePorts(undefined);
    expect(settingsPorts()).not.toBe(given);
  });
});
