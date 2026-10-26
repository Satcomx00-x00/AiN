/**
 * The rest of the adapters between features and the backend (see services.test.ts): the commands
 * each one calls, the events it follows, and how it cleans up what comes back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), once: vi.fn(), emit: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const { listen } = await import("@tauri-apps/api/event");
const { tauriStats } = await import("./stats/service");
const { tauriClipboard } = await import("./clipboard/service");
const { tauriVolume } = await import("./volume/service");
const { tauriDictation } = await import("./dictation/service");
const { tauriTts } = await import("./tts/service");
const { tauriMedia } = await import("./media/service");
const { tauriPrivacy } = await import("./privacy/service");
const { tauriPalette, idlePalette } = await import("./palette/service");
const { tauriZones, idleZones } = await import("./zones/service");

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
});

/**
 * Backs `listen` and `invoke` with a fake backend: listening to an event delivers `pushed[event]`,
 * and calling a command returns `replies[command]`. Every call is logged, in order.
 */
function backend(replies: Record<string, unknown>, pushed: Record<string, unknown[]> = {}) {
  const log: string[] = [];
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    log.push(`listen ${name}`);
    for (const payload of pushed[name] ?? []) handler({ event: name, id: 0, payload } as never);
    return () => log.push(`unlisten ${name}`);
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    log.push(`invoke ${command}`);
    return replies[command];
  });
  return log;
}

/** Follows `watch`, returning what it delivered and the log of backend calls. */
async function follow<T>(watch: (onChange: (value: T) => void) => Promise<() => void>, log: string[]) {
  const seen: T[] = [];
  const stop = await watch((v) => seen.push(v));
  stop();
  return { seen, log };
}

describe("stats", () => {
  it("cleans up a sample once there is one", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ cpu: 12.5, memUsed: 1, memTotal: 2, rxPerSec: null, txPerSec: 4, sampledAt: 7 });
    expect(await tauriStats.stats()).toEqual({ cpu: 12.5, memUsed: 1, memTotal: 2, rxPerSec: 0, txPerSec: 4, sampledAt: 7 });
  });
});

describe("clipboard", () => {
  it("reads the history and clears it through the clipboard plugin", async () => {
    const history = [{ text: "hi", copiedAt: 1 }];
    vi.mocked(invoke).mockResolvedValueOnce(history);
    expect(await tauriClipboard.history()).toEqual(history);
    expect(invoke).toHaveBeenLastCalledWith("plugin:clipboard|history");
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    expect(await tauriClipboard.clear()).toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith("plugin:clipboard|clear");
  });
});

describe("volume", () => {
  it("follows the sources, cleaning up their levels", async () => {
    const speakers = { id: "device:a", kind: "device", name: "Speakers", level: 0.5, muted: false, default: true, active: true };
    const log = backend({ "plugin:volume|sources": [{ ...speakers, level: null }] }, { "plugin:volume:sources-changed": [[speakers]] });
    const { seen } = await follow(tauriVolume.watchSources, log);
    expect(seen).toEqual([[speakers], [{ ...speakers, level: 0 }]]);
    expect(log).toEqual(["listen plugin:volume:sources-changed", "invoke plugin:volume|sources", "unlisten plugin:volume:sources-changed"]);
  });

  it("reads the output's loudness, an unknown one as silence", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(0.25).mockResolvedValueOnce(null);
    expect(await tauriVolume.peak()).toBe(0.25);
    expect(await tauriVolume.peak()).toBe(0);
    expect(invoke).toHaveBeenLastCalledWith("plugin:volume|peak");
  });

  it("mutes the default output when no source is given", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await tauriVolume.setMuted(false);
    expect(invoke).toHaveBeenLastCalledWith("plugin:volume|set_muted", { source: null, muted: false });
  });
});

describe("dictation", () => {
  it("follows the phase, cleaning up the listening level", async () => {
    const log = backend({ "plugin:dictation|state": { phase: "idle" } }, { "plugin:dictation:phase-changed": [{ phase: "listening", level: null, seconds: 2 }] });
    const { seen } = await follow(tauriDictation.watch, log);
    expect(seen).toEqual([{ phase: "listening", level: 0, seconds: 2 }, { phase: "idle" }]);
    expect(log.slice(0, 2)).toEqual(["listen plugin:dictation:phase-changed", "invoke plugin:dictation|state"]);
  });

  it("follows the model's download", async () => {
    const ready = { model: "whisper-small", dir: "D:/m", installed: ["whisper-small"], state: "ready" };
    const log = backend({ "plugin:dictation|model_status": ready }, { "plugin:dictation:model-changed": [{ ...ready, state: "downloading", received: 1, total: 2 }] });
    const { seen } = await follow(tauriDictation.watchModel, log);
    expect(seen.map((s) => s.state)).toEqual(["downloading", "ready"]);
    expect(log.slice(0, 2)).toEqual(["listen plugin:dictation:model-changed", "invoke plugin:dictation|model_status"]);
  });

  it("lists the microphones", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([{ id: "wasapi:{a}", name: "Headset" }]);
    expect(await tauriDictation.microphones()).toEqual([{ id: "wasapi:{a}", name: "Headset" }]);
    expect(invoke).toHaveBeenLastCalledWith("plugin:dictation|microphones");
  });
});

describe("read aloud", () => {
  it("follows the reading's phase and the model's download", async () => {
    const phases = await follow(tauriTts.watch, backend({ "plugin:tts|state": { phase: "idle" } }, { "plugin:tts:phase-changed": [{ phase: "speaking", text: "Hi" }] }));
    expect(phases.seen).toEqual([{ phase: "speaking", text: "Hi" }, { phase: "idle" }]);
    expect(phases.log.slice(0, 2)).toEqual(["listen plugin:tts:phase-changed", "invoke plugin:tts|state"]);

    const missing = { model: "kokoro-en", dir: "D:/m", installed: [], state: "missing", size: 1 };
    const models = await follow(tauriTts.watchModel, backend({ "plugin:tts|model_status": missing }));
    expect(models.seen).toEqual([missing]);
    expect(models.log.slice(0, 2)).toEqual(["listen plugin:tts:model-changed", "invoke plugin:tts|model_status"]);
  });
});

describe("media", () => {
  it("follows the track, then fetches the artwork and sends controls", async () => {
    const track = { title: "Song", artist: "A", album: "", app: "Spotify", playing: true, positionMs: 0, durationMs: 1, measuredAt: 0, artworkKey: "k" };
    const log = backend({ "plugin:media|state": track, "plugin:media|artwork": "data:image/png;base64,AA", "plugin:media|control": null }, { "plugin:media:track-changed": [null] });
    const { seen } = await follow(tauriMedia.watch, log);
    expect(seen).toEqual([null, track]);
    expect(await tauriMedia.artwork()).toBe("data:image/png;base64,AA");
    expect(await tauriMedia.control("next")).toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith("plugin:media|control", { action: "next" });
  });
});

describe("privacy", () => {
  it("follows who uses the microphone and camera", async () => {
    const log = backend({ "plugin:privacy|state": { mic: ["Discord"], camera: [] } }, { "plugin:privacy:usage-changed": [null] });
    const { seen } = await follow(tauriPrivacy.watch, log);
    expect(seen).toEqual([null, { mic: ["Discord"], camera: [] }]);
    expect(log).toEqual(["listen plugin:privacy:usage-changed", "invoke plugin:privacy|state", "unlisten plugin:privacy:usage-changed"]);
  });
});

describe("palette", () => {
  it("calls each command by its Rust name, with its arguments", async () => {
    const hit = { path: "/home/me/a.md", name: "a.md", folder: "~", dir: false };
    const log = backend({ "plugin:palette|apps": [{ id: "x", name: "X", keywords: "", detail: "" }], "plugin:palette|files": [hit], "plugin:palette|browse": [hit] });
    expect(await tauriPalette.apps()).toHaveLength(1);
    expect(await tauriPalette.files("a", 5)).toEqual([hit]);
    expect(await tauriPalette.browse("~/", 9)).toEqual([hit]);
    await tauriPalette.launch("x");
    await tauriPalette.open("/home/me/a.md");
    await tauriPalette.reveal("/home/me/a.md");
    await tauriPalette.run("ls");
    await tauriPalette.system("lock");
    await tauriPalette.openUrl("https://example.com");
    expect(log.map((l) => l.replace("invoke plugin:palette|", ""))).toEqual(["apps", "files", "browse", "launch", "open", "reveal", "run", "system", "open_url"]);
    expect(vi.mocked(invoke).mock.calls.slice(1).map(([, args]) => args)).toEqual([
      { query: "a", limit: 5 },
      { path: "~/", limit: 9 },
      { id: "x" },
      { path: "/home/me/a.md" },
      { path: "/home/me/a.md" },
      { command: "ls" },
      { action: "lock" },
      { url: "https://example.com" },
    ]);
  });

  it("finds nothing and does nothing in the browser previews", async () => {
    expect([await idlePalette.apps(), await idlePalette.files("a", 1), await idlePalette.browse("~", 1)]).toEqual([[], [], []]);
    for (const done of [idlePalette.launch("x"), idlePalette.open("p"), idlePalette.reveal("p"), idlePalette.run("ls"), idlePalette.system("lock"), idlePalette.openUrl("u")]) {
      await expect(done).resolves.toBeUndefined();
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("zones", () => {
  it("calls each command by its Rust name, reading the floats JSON may have turned to null", async () => {
    const support = { moves: true, drags: true, note: null, install: false };
    const log = backend({ "plugin:zones|support": support, "plugin:zones|layout": [{ x: 0, y: null, w: 0.5, h: 1 }] });
    expect(await tauriZones.support()).toEqual(support);
    expect(await tauriZones.layout("columns", 2, true)).toEqual([{ x: 0, y: 0, w: 0.5, h: 1 }]);
    await tauriZones.snap(1);
    await tauriZones.screen(-1);
    await tauriZones.cancel(true);
    await tauriZones.installHelper();
    expect(log.map((l) => l.replace("invoke plugin:zones|", ""))).toEqual(["support", "layout", "snap", "screen", "cancel", "install_helper"]);
    expect(vi.mocked(invoke).mock.calls.map(([, args]) => args)).toEqual([undefined, { template: "columns", count: 2, portrait: true }, { zone: 1 }, { by: -1 }, { refocus: true }, undefined]);
  });

  it("follows the overlay, starting from the backend's state", async () => {
    const wire = { zones: [{ x: 1, y: 2, w: 3, h: null }], lit: [0], picking: true, screen: 0, screens: 1 };
    const log = backend({ "plugin:zones|overlay_state": { ...wire, picking: false } }, { "plugin:zones:overlay-changed": [wire] });
    const { seen } = await follow(tauriZones.watchOverlay, log);
    expect(seen.map((o) => [o.picking, o.zones[0]?.h])).toEqual([
      [true, 0],
      [false, 0],
    ]);
    expect(log).toEqual(["listen plugin:zones:overlay-changed", "invoke plugin:zones|overlay_state", "unlisten plugin:zones:overlay-changed"]);
  });

  it("splits the screen in even columns and moves nothing in the browser previews", async () => {
    expect(await idleZones.support()).toMatchObject({ moves: false, drags: false, install: false });
    expect(await idleZones.layout("columns", 0, false)).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
    const seen: unknown[] = [];
    const stop = await idleZones.watchOverlay((o) => seen.push(o.zones));
    stop();
    expect(seen).toEqual([[]]);
    for (const done of [idleZones.snap(0), idleZones.screen(1), idleZones.cancel(false), idleZones.installHelper()]) await expect(done).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
