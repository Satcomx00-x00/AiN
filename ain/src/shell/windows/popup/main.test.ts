// @vitest-environment happy-dom
/**
 * The shortcut popup's entry point: it hosts the commands' views in a sheet, against the app's
 * backend inside Tauri, and against sample clips in the browser preview.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SurfaceOptions } from "../../surface";
import type { Services } from "../../../features/services";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const hostCommands = vi.fn<(options: SurfaceOptions) => void>();
vi.mock("../../surface", () => ({ hostCommands }));

/**
 * Loads a fresh copy of the popup's script, in the app or in the preview; resolves with what it
 * hosts, and the modules it was given them from (fresh copies too).
 */
async function load({ inApp }: { inApp: boolean }) {
  document.body.replaceChildren();
  hostCommands.mockClear();
  if (inApp) Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.resetModules();
  await import("./main");
  const options: SurfaceOptions = hostCommands.mock.calls[0]![0];
  return {
    options,
    ...(await import("../../commands")),
    ...(await import("../../settings")),
    ...(await import("../../../features/services")),
    ...(await import("../../../features")),
    layout: (await import("../../../features/layout")).layout,
  };
}

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.useRealTimers();
});

describe("the popup window", () => {
  it("hosts every built-in command in a sheet of its page", async () => {
    const { options, catalogue, layout } = await load({ inApp: false });
    expect(hostCommands).toHaveBeenCalledTimes(1);
    expect(options.container.className).toBe("sheet");
    expect(document.body.lastElementChild).toBe(options.container);
    expect(options.catalogue).toBe(catalogue);
    expect(options.layout).toBe(layout);
  });

  it("runs on the app's backend inside Tauri", async () => {
    const { options, tauriServices, tauriPopup, tauriSettings } = await load({ inApp: true });
    expect(options.services).toBe(tauriServices);
    expect(options.popup).toBe(tauriPopup);
    expect(options.store).toBe(tauriSettings);
  });

  it("shows sample clips in the browser preview, newest first, and pastes nowhere", async () => {
    const now = new Date(2026, 9, 16, 9, 41).getTime();
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const { options, idlePopup, tauriSettings } = await load({ inApp: false });
    expect(options.popup).toBe(idlePopup);
    expect(options.store).not.toBe(tauriSettings);
    const { clipboard } = options.services as Services;
    const clips = await clipboard.history();
    expect(clips.map((c) => c.text)).toEqual([
      "https://v2.tauri.app/start/",
      "#0A84FF",
      "const island = await mount(root, modules);\nexport default island;",
      "hello@example.com",
      "Ship the island widget before Friday, then polish the timer ring and the settings page.",
      "42 500,00",
    ]);
    const ages = clips.map((c) => now - c.copiedAt);
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
    expect(ages[0]).toBe(4_000);
    // Nothing reaches a backend: each action just resolves.
    await expect(clipboard.copy("x")).resolves.toBeUndefined();
    await expect(clipboard.copyImage(new ImageData(1, 1))).resolves.toBeUndefined();
    await expect(clipboard.clear()).resolves.toBeUndefined();
    expect(await clipboard.history()).toHaveLength(6);
  });

  it("keeps the app's other services in the preview", async () => {
    const { options, tauriServices } = await load({ inApp: false });
    const services = options.services as Services;
    expect(services.stats).toBe(tauriServices.stats);
    expect(services.clipboard).not.toBe(tauriServices.clipboard);
  });
});
