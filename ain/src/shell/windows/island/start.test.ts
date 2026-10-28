// @vitest-environment happy-dom
/**
 * What the island's composition root does around the island itself: registering shortcuts,
 * opening Settings, saving options and quitting for it, and keeping up with settings that change
 * while it starts. The island is a stand-in that records what it is told.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Extras, IslandHandle } from "../../host";
import type { Settings, SettingsPort } from "../../settings";
import type { PopupPort } from "../../commands";
import type { ExtensionsPort } from "../../extensions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

type Configure = IslandHandle<never>["configure"];
const island = { configure: vi.fn<Configure>(), play: vi.fn(), command: vi.fn() };
/** What the island was given when mounted; `during` runs while it mounts. */
const mounted: { extras?: Extras; during?: () => Promise<void> } = {};
vi.mock("../../host", () => ({
  mount: vi.fn(async (_el: unknown, _plugins: unknown, _services: unknown, _win: unknown, _initial: unknown, extras: Extras) => {
    mounted.extras = extras;
    await mounted.during?.();
    return island;
  }),
}));

const { start, extensionLoader } = await import("./app");
const { defaults, memorySettings } = await import("../../settings");
const { layout } = await import("../../../features/layout");
const base = defaults(layout);
const { idlePopup } = await import("../../commands");
const { memorySecrets } = await import("../../secrets");

const settle = () => new Promise((r) => setTimeout(r, 0));
const noFolder: ExtensionsPort = { list: async () => ({ dir: "", plugins: [] }), openDir: async () => {} };
const win = { island: async () => ({ width: 0, height: 0, hasNotch: false }), layout: async () => {}, autoHide: async () => {}, onReveal: async () => () => {} };

function run(store: SettingsPort = memorySettings(), popup: PopupPort = idlePopup) {
  const root = document.createElement("div");
  return start(root, {} as never, win, store, popup, noFolder, async () => ({}), memorySecrets());
}

afterEach(() => {
  island.configure.mockReset();
  delete mounted.during;
  vi.restoreAllMocks();
});

describe("starting the island", () => {
  it("warns about each shortcut the system wouldn't register", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await run(memorySettings(), { ...idlePopup, bind: async () => ({ "clipboard.history": "already used by another app" }) });
    await settle();
    expect(warn).toHaveBeenCalledWith("[island] shortcut for clipboard.history: already used by another app");
  });

  it("logs when shortcuts can't be registered at all", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("no hotkey service");
    await run(memorySettings(), { ...idlePopup, bind: async () => Promise.reject(failure) });
    await settle();
    expect(error).toHaveBeenCalledWith("[island] could not register shortcuts", failure);
  });

  it("opens Settings where the island asks, and logs when it can't", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = memorySettings();
    const failure = new Error("no window");
    const open = vi.spyOn(store, "open").mockResolvedValueOnce().mockRejectedValueOnce(failure);
    await run(store);
    mounted.extras?.openSettings?.("widgets:clock");
    expect(open).toHaveBeenCalledWith("widgets:clock");
    mounted.extras?.openSettings?.();
    await settle();
    expect(error).toHaveBeenCalledWith("[island] could not open settings", failure);
  });

  it("saves a plugin's options merged into what it had, and applies them at once", async () => {
    const store = memorySettings();
    const save = vi.spyOn(store, "save");
    await run(store);
    mounted.extras?.saveOptions?.("clock", { format: "12" });
    mounted.extras?.saveOptions?.("clock", { seconds: true });
    const saved = save.mock.calls.at(-1)?.[0] as Settings;
    expect(saved.options.clock).toEqual({ format: "12", seconds: true });
    expect(island.configure.mock.calls.some(([s]) => JSON.stringify(s.options.clock) === JSON.stringify({ format: "12", seconds: true }))).toBe(true);
  });

  it("logs options it couldn't save", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = memorySettings();
    const failure = new Error("disk full");
    vi.spyOn(store, "save").mockRejectedValue(failure);
    await run(store);
    mounted.extras?.saveOptions?.("clock", { format: "12" });
    await settle();
    expect(error).toHaveBeenCalledWith("[island] could not save options", failure);
  });

  it("quits the app when asked, and logs when it can't", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = memorySettings();
    const failure = new Error("refused");
    const quit = vi.spyOn(store, "quit").mockRejectedValue(failure);
    await run(store);
    mounted.extras?.quit?.();
    await settle();
    expect(quit).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("[island] could not quit", failure);
  });

  it("applies settings saved while the island was starting, once it's up", async () => {
    const store = memorySettings();
    mounted.during = () => store.save({ ...base, general: { ...base.general, pillWidth: 320 } });
    await run(store);
    expect(island.configure.mock.calls.at(-1)?.[0].general.pillWidth).toBe(320);
  });

  it("drops settings outrun by newer ones while plugins were loading", async () => {
    const store = memorySettings();
    await run(store);
    await settle();
    island.configure.mockReset();
    void store.save({ ...base, general: { ...base.general, pillWidth: 300 } });
    void store.save({ ...base, general: { ...base.general, pillWidth: 340 } });
    await settle();
    // Each change applies at once; only the newest is applied again with the plugins loaded for it.
    const withPlugins = island.configure.mock.calls.filter((args) => args.length === 5).map(([s]) => s.general.pillWidth);
    expect(withPlugins).toEqual([340]);
    expect(island.configure.mock.calls.at(-1)?.[0].general.pillWidth).toBe(340);
  });
});

describe("loading plugin files, when something fails", () => {
  it("lets a file that didn't load sit beside the ones loaded after it", async () => {
    const list = vi.fn(async () => ({
      dir: "/plugins",
      plugins: [
        { file: "broken.js", source: "broken.js", problem: null },
        { file: "fine.js", source: "fine.js", problem: null },
      ],
    }));
    const importer = vi.fn(async (source: string) => {
      if (source === "broken.js") throw new Error("syntax error");
      return { default: () => ({ id: "fine", label: "Fine", description: "", icon: "", slots: ["tab"], setup: () => ({}) }) };
    });
    const loader = extensionLoader({ list, openDir: async () => {} }, importer, vi.fn());
    await loader.sync(["broken.js"]);
    const all = await loader.sync(["broken.js", "fine.js"]);
    expect(all.map((e) => [e.file, e.plugin?.id ?? null, e.problem])).toEqual([
      ["broken.js", null, "failed to load: Error: syntax error"],
      ["fine.js", "fine", null],
    ]);
  });

  it("keeps syncing after one sync failed outright", async () => {
    const list = vi
      .fn<ExtensionsPort["list"]>()
      .mockImplementationOnce(() => {
        throw new Error("port gone");
      })
      .mockResolvedValue({ dir: "/plugins", plugins: [{ file: "a.js", source: "a.js", problem: null }] });
    const importer = async () => ({ default: () => ({ id: "aaa", label: "A", description: "", icon: "", slots: ["tab"], setup: () => ({}) }) });
    const loader = extensionLoader({ list, openDir: async () => {} }, importer, vi.fn());
    await expect(loader.sync(["a.js"])).rejects.toThrow("port gone");
    expect((await loader.sync(["a.js"])).map((e) => e.plugin?.id)).toEqual(["aaa"]);
  });
});

describe("plugin files' notifiers and shortcuts", () => {
  const files: ExtensionsPort = {
    list: async () => ({ dir: "", plugins: [{ file: "ticker.js", source: "ticker", problem: null }, { file: "tab.js", source: "tab", problem: null }] }),
    openDir: async () => {},
  };
  const importer = async (source: string) =>
    source === "ticker"
      ? { default: () => ({ id: "ticker", label: "Ticker", show: () => {} }) }
      : { default: () => ({ id: "tabby", label: "Tabby", description: "", icon: "", slots: ["tab"], setup: () => ({}) }) };

  it("hands the island the notifiers of files turned on, and only those", async () => {
    const store = memorySettings();
    await store.save({ ...base, extensions: ["ticker.js", "tab.js"] });
    await start(document.createElement("div"), {} as never, win, store, idlePopup, files, importer, memorySecrets());
    expect(mounted.extras?.notifiers?.map((n) => n.id)).toEqual(["ticker"]);
    await store.save({ ...base, extensions: ["tab.js"] });
    await settle();
    expect(island.configure.mock.calls.at(-1)?.[4]).toEqual([]);
  });

  it("passes the shortcuts of plugin files on to the island", async () => {
    let heard: ((command: string, kind: "press" | "release" | "tap") => void) | undefined;
    const popup: PopupPort = { ...idlePopup, onAction: async (f) => ((heard = f), () => {}) };
    await run(memorySettings(), popup);
    heard?.("tabby.go", "press");
    expect(island.command).toHaveBeenCalledWith("tabby.go", "press");
  });

  it("uses the corner toast window in the app", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    await run();
    expect(mounted.extras?.toasts).toBeDefined();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});

