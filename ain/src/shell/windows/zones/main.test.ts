// @vitest-environment happy-dom
/**
 * The zones overlay's entry point: it draws the zones the backend sends inside Tauri, and in the
 * browser preview a sample priority grid, during a drag or as the picker (`?pick`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overlay, ZonesPort } from "../../../features/zones/service";
import type { SettingsPort } from "../../settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const mountOverlay = vi.fn<(root: HTMLElement, port: ZonesPort) => () => void>(() => () => {});
vi.mock("../../../features/zones/overlay", () => ({ mountOverlay }));

/** Loads a fresh copy of the window's script at `search`, in the app or in the preview. */
async function load({ inApp = false, search = "" } = {}) {
  document.body.replaceChildren();
  mountOverlay.mockClear();
  history.replaceState(null, "", `/${search}`);
  if (inApp) Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.resetModules();
  const settings = await import("../../settings");
  const watched: ((raw: unknown) => void)[] = [];
  const store = { watch: async (onChange: (raw: unknown) => void) => (watched.push(onChange), () => {}) } as unknown as SettingsPort;
  vi.spyOn(settings, "memorySettings").mockReturnValue(store);
  const tauriWatch = vi.spyOn(settings.tauriSettings, "watch").mockImplementation(async (onChange) => (watched.push(onChange), () => {}));
  await import("./main");
  const [root, port] = mountOverlay.mock.calls[0]!;
  return { root, port, watched, tauriWatch, ...(await import("../../../features/zones/service")), settings };
}

/** What the sample overlay sends first. */
async function first(port: ZonesPort): Promise<Overlay> {
  let seen: Overlay | undefined;
  const stop = await port.watchOverlay((o) => (seen = o));
  stop();
  return seen!;
}

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("the zones window", () => {
  it("draws what the backend sends inside Tauri, in the accent color chosen in Settings", async () => {
    const { root, port, tauriZones, tauriWatch, watched, settings } = await load({ inApp: true });
    expect(port).toBe(tauriZones);
    expect(root.className).toBe("zo-root");
    expect(document.body.lastElementChild).toBe(root);
    expect(tauriWatch).toHaveBeenCalled();
    const saved = settings.defaults((await import("../../../features/layout")).layout);
    watched[0]!({ ...saved, general: { ...saved.general, accentColor: "#ff2d55" } });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#ff2d55");
  });

  it("shows a drag over a sample priority grid in the preview, lighting the middle zone", async () => {
    const { port, tauriZones, tauriWatch } = await load();
    expect(port).not.toBe(tauriZones);
    expect(tauriWatch).not.toHaveBeenCalled();
    const overlay = await first(port);
    expect(overlay.zones).toHaveLength(3);
    expect([overlay.picking, overlay.lit, overlay.screens]).toEqual([false, [1], 2]);
  });

  it("shows the picker over the sample with ?pick", async () => {
    const { port } = await load({ search: "?pick" });
    const overlay = await first(port);
    expect([overlay.picking, overlay.lit]).toEqual([true, []]);
  });
});
