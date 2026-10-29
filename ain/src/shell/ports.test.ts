/**
 * The shell's adapters to the backend: the command names and argument shapes they send must match
 * the Rust side, and what they hand back is what the backend answered.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), once: vi.fn(), emit: vi.fn(), emitTo: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const { emitTo, listen } = await import("@tauri-apps/api/event");
const { tauriToasts } = await import("./toasts");
const { idlePopup, tauriPopup } = await import("./commands");
const { tauriUpdater } = await import("./updater");
const { tauriWindow } = await import("./window");
const { tauriSecrets } = await import("./secrets");
const { tauriSettings } = await import("./settings");
const { noExtensions, tauriExtensions } = await import("./extensions");

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
  vi.mocked(emitTo).mockReset();
});

/** Makes `listen` deliver `payloads` to whoever subscribes, and record the order of calls. */
function events(log: string[], payloads: unknown[] = []) {
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    log.push(`listen ${name}`);
    for (const payload of payloads) handler({ event: name, id: 0, payload } as never);
    return () => log.push(`unlisten ${name}`);
  });
}

describe("the popup", () => {
  it("binds shortcuts and hands back the ones that failed", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ "clock.go": "taken" });
    const map = { "clock.go": { shortcut: "Super+KeyK", surface: "popup" as const, label: "Go" } };
    expect(await tauriPopup.bind(map)).toEqual({ "clock.go": "taken" });
    expect(invoke).toHaveBeenLastCalledWith("plugin:popup|bind", { bindings: map });
  });

  it("listens for re-binds before reading the failures, so none is missed", async () => {
    const log: string[] = [];
    events(log, [{ "a.b": "pushed" }]);
    vi.mocked(invoke).mockImplementation(async (command) => (log.push(`invoke ${command}`), { "a.b": "read" }));
    const seen: unknown[] = [];
    const stop = await tauriPopup.watchFailures((f) => seen.push(f));
    expect(log).toEqual(["listen plugin:popup:bindings-changed", "invoke plugin:popup|failures"]);
    expect(seen).toEqual([{ "a.b": "pushed" }, { "a.b": "read" }]);
    stop();
    expect(log.at(-1)).toBe("unlisten plugin:popup:bindings-changed");
  });

  it("opens, hides and pastes, resolving with nothing", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await tauriPopup.open("clipboard.history", "screen")).toBeUndefined();
    expect(await tauriPopup.hide()).toBeUndefined();
    expect(await tauriPopup.paste()).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["plugin:popup|open", { command: "clipboard.history", surface: "screen" }],
      ["plugin:popup|hide"],
      ["plugin:popup|paste"],
    ]);
  });

  it("tells when an action command's shortcut is pressed or released", async () => {
    const log: string[] = [];
    events(log, [{ command: "pomodoro.start", kind: "press" }]);
    const heard: unknown[] = [];
    const stop = await tauriPopup.onAction((command, kind) => heard.push([command, kind]));
    expect([log, heard]).toEqual([["listen plugin:popup:action"], [["pomodoro.start", "press"]]]);
    stop();
  });

  it("tells which command the popup was shown for", async () => {
    const log: string[] = [];
    events(log, [{ command: "clipboard.history" }]);
    const shown: string[] = [];
    const stop = await tauriPopup.onShow((c) => shown.push(c));
    expect([log, shown]).toEqual([["listen plugin:popup:shown"], ["clipboard.history"]]);
    stop();
    expect(log.at(-1)).toBe("unlisten plugin:popup:shown");
  });

  it("does nothing in the browser previews, with no failures to report", async () => {
    expect(await idlePopup.bind({ "a.b": { shortcut: "F9", surface: "popup", label: "B" } })).toEqual({});
    const failures = vi.fn();
    const stop = await idlePopup.watchFailures(failures);
    expect(failures).toHaveBeenCalledExactlyOnceWith({});
    expect(stop()).toBeUndefined();
    await expect(Promise.all([idlePopup.open("a.b", "popup"), idlePopup.hide(), idlePopup.paste()])).resolves.toEqual([undefined, undefined, undefined]);
    const shown = vi.fn();
    (await idlePopup.onShow(shown))();
    expect(shown).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});

describe("the updater", () => {
  const report = { current: "0.7.0", state: { kind: "upToDate" }, releases: "https://example.com/releases" };

  it("asks for the status and checks, handing back the backend's report", async () => {
    vi.mocked(invoke).mockResolvedValue(report);
    expect(await tauriUpdater.status()).toEqual(report);
    expect(await tauriUpdater.check()).toEqual(report);
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin:updates|status"], ["plugin:updates|check"]]);
  });

  it("installs and opens the releases page, resolving with nothing", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await tauriUpdater.install()).toBeUndefined();
    expect(await tauriUpdater.openReleases()).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin:updates|install"], ["plugin:updates|open_releases"]]);
  });

  it("passes on every change it is told about", async () => {
    const log: string[] = [];
    events(log, [report]);
    const seen: unknown[] = [];
    const stop = await tauriUpdater.watch((r) => seen.push(r));
    expect([log, seen]).toEqual([["listen plugin:updates:update-changed"], [report]]);
    stop();
    expect(log.at(-1)).toBe("unlisten plugin:updates:update-changed");
  });
});

describe("the island window", () => {
  it("measures the island, refusing a size that isn't real", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ width: 200, height: 32, hasNotch: true, extra: 1 });
    expect(await tauriWindow.island()).toEqual({ width: 200, height: 32, hasNotch: true });
    expect(invoke).toHaveBeenLastCalledWith("plugin:island|info");
    vi.mocked(invoke).mockResolvedValueOnce({ width: null, height: 32, hasNotch: false });
    await expect(tauriWindow.island()).rejects.toThrow("invalid island size null×32");
  });

  it("lays out the window and sets the auto-hide rule, resolving with nothing", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const canvas = { width: 960, height: 400 };
    const region = { width: 200, height: 32 };
    expect(await tauriWindow.layout(canvas, region)).toBeUndefined();
    expect(await tauriWindow.autoHide(500, 760)).toBeUndefined();
    expect(await tauriWindow.autoHide(null, 760)).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["plugin:island|layout", { canvas, region, extra: [] }],
      ["plugin:island|auto_hide", { dwell: 500, grace: 760 }],
      ["plugin:island|auto_hide", { dwell: null, grace: 760 }],
    ]);
  });

  it("tells when the auto-hide rule shows or hides the pill", async () => {
    const log: string[] = [];
    events(log, [true, false]);
    const seen: boolean[] = [];
    const stop = await tauriWindow.onReveal((shown) => seen.push(shown));
    expect([log, seen]).toEqual([["listen plugin:island:revealed"], [true, false]]);
    stop();
    expect(log.at(-1)).toBe("unlisten plugin:island:revealed");
  });
});

describe("secrets", () => {
  it("reads, saves and asks which are saved, in the plugin's name", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("k3y").mockResolvedValueOnce(null).mockResolvedValueOnce([true, false]);
    const keys = ["apiKey", "token"] as const;
    expect(await tauriSecrets.get("weather", "apiKey")).toBe("k3y");
    expect(await tauriSecrets.set("weather", "apiKey", "new")).toBeUndefined();
    expect(await tauriSecrets.saved("weather", keys)).toEqual([true, false]);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["plugin:secrets|get", { plugin: "weather", key: "apiKey" }],
      ["plugin:secrets|set", { plugin: "weather", key: "apiKey", value: "new" }],
      ["plugin:secrets|saved_keys", { plugin: "weather", keys: ["apiKey", "token"] }],
    ]);
  });

  it("tells which plugin's secret changed", async () => {
    const log: string[] = [];
    events(log, [{ plugin: "weather", key: "apiKey" }]);
    const seen: string[] = [];
    const stop = await tauriSecrets.onChange((plugin, key) => seen.push(`${plugin}/${key}`));
    expect([log, seen]).toEqual([["listen plugin:secrets:secret-changed"], ["weather/apiKey"]]);
    stop();
    expect(log.at(-1)).toBe("unlisten plugin:secrets:secret-changed");
  });
});

describe("settings", () => {
  it("listens for changes before reading the stored settings, so none is missed", async () => {
    const log: string[] = [];
    events(log, [{ version: 1, pushed: true }]);
    vi.mocked(invoke).mockImplementation(async (command) => (log.push(`invoke ${command}`), { version: 1 }));
    const seen: unknown[] = [];
    const stop = await tauriSettings.watch((raw) => seen.push(raw));
    expect(log).toEqual(["listen plugin:settings:settings-changed", "invoke plugin:settings|get"]);
    expect(seen).toEqual([{ version: 1, pushed: true }, { version: 1 }]);
    stop();
    expect(log.at(-1)).toBe("unlisten plugin:settings:settings-changed");
  });

  it("saves, opens the window (at a place or not) and plays a greeting, resolving with nothing", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const value = { version: 1 } as never;
    expect(await tauriSettings.save(value)).toBeUndefined();
    expect(await tauriSettings.open("widgets:clock")).toBeUndefined();
    expect(await tauriSettings.open()).toBeUndefined();
    expect(await tauriSettings.playGreeting("hello")).toBeUndefined();
    expect(await tauriSettings.testNotification()).toBeUndefined();
    expect(await tauriSettings.setAutostart(true)).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["plugin:settings|set", { value }],
      ["plugin:settings|open", { target: "widgets:clock" }],
      ["plugin:settings|open", { target: null }],
      ["plugin:settings|play_greeting", { id: "hello" }],
      ["plugin:settings|test_notification"],
      ["plugin:settings|set_autostart", { enabled: true }],
    ]);
  });

  it("asks whether AiN starts with the system", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);
    expect(await tauriSettings.autostart()).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("plugin:settings|autostart");
  });

  it("passes on where to navigate and which greeting to play", async () => {
    const log: string[] = [];
    events(log, ["widgets:clock"]);
    const targets: string[] = [];
    const greetings: string[] = [];
    const stopNavigate = await tauriSettings.onNavigate((t) => targets.push(t));
    const stopPlay = await tauriSettings.onPlayGreeting((id) => greetings.push(id));
    let tests = 0;
    const stopTest = await tauriSettings.onTestNotification(() => tests++);
    expect(log).toEqual(["listen plugin:settings:navigate", "listen plugin:settings:play-greeting", "listen plugin:settings:test-notification"]);
    expect([targets, greetings, tests]).toEqual([["widgets:clock"], ["widgets:clock"], 1]);
    stopNavigate();
    stopPlay();
    stopTest();
    expect(log.slice(-3)).toEqual(["unlisten plugin:settings:navigate", "unlisten plugin:settings:play-greeting", "unlisten plugin:settings:test-notification"]);
  });
});

describe("the plugins folder", () => {
  it("lists the plugin files and opens the folder", async () => {
    const listing = { dir: "/plugins", plugins: [{ file: "a.js", source: "export default () => ({})", problem: null }] };
    vi.mocked(invoke).mockResolvedValueOnce(listing).mockResolvedValueOnce(null);
    expect(await tauriExtensions.list()).toEqual(listing);
    expect(await tauriExtensions.openDir()).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin:extensions|list"], ["plugin:extensions|open_dir"]]);
  });

  it("is empty in the browser previews", async () => {
    expect(await noExtensions.list()).toEqual({ dir: "", plugins: [] });
    expect(await noExtensions.openDir()).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("the corner toasts", () => {
  const state = (titles: string[]) => ({ notices: titles.map((title) => ({ title })), settings: {}, colors: {} }) as never;

  it("makes the window on the first toast, then sends it every change", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const toasts = tauriToasts();
    await toasts.sync(state([]));
    expect([vi.mocked(invoke).mock.calls, vi.mocked(emitTo).mock.calls]).toEqual([[], []]);
    await toasts.sync(state(["A"]));
    await toasts.sync(state([]));
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin:toasts|ensure"]]);
    expect(vi.mocked(emitTo).mock.calls).toEqual([
      ["toasts", "toasts:sync", state(["A"])],
      ["toasts", "toasts:sync", state([])],
    ]);
  });

  it("hears what the user did, and sends the latest again once the window is ready", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    const unlisten = vi.fn();
    vi.mocked(listen).mockImplementation(async (name, handler) => (handlers.set(name, handler as never), unlisten));
    const toasts = tauriToasts();
    const heard: unknown[] = [];
    const stop = await toasts.listen((e) => heard.push(e));
    handlers.get("toasts:ready")!({ payload: null });
    expect(emitTo).not.toHaveBeenCalled();
    await toasts.sync(state(["A"]));
    handlers.get("toasts:event")!({ payload: { kind: "close", id: "n1" } });
    handlers.get("toasts:ready")!({ payload: null });
    await vi.waitFor(() => expect(emitTo).toHaveBeenCalledTimes(2));
    expect(heard).toEqual([{ kind: "close", id: "n1" }]);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
