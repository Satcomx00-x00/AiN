/**
 * The adapters between features and the backend: what each sends (command names and argument
 * shapes must match the Rust side) and how they clean up what comes back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), once: vi.fn(), emit: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const { listen } = await import("@tauri-apps/api/event");
const { tauriStats, fromWire } = await import("./stats/service");
const { tauriClipboard } = await import("./clipboard/service");
const { tauriVolume, output } = await import("./volume/service");
const { tauriDictation, phase } = await import("./dictation/service");
const { tauriMedia } = await import("./media/service");
const { tauriCapture, decode } = await import("./screenshot/service");

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
});

/** Makes `listen` deliver `payloads` to whoever subscribes, and record the order of calls. */
function events(log: string[], payloads: unknown[] = []) {
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    log.push(`listen ${name}`);
    for (const payload of payloads) handler({ event: name, id: 0, payload } as never);
    return () => log.push(`unlisten ${name}`);
  });
}

describe("stats", () => {
  it("passes through a missing first sample", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    expect(await tauriStats.stats()).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("plugin:stats|latest");
  });

  it("turns non-finite rates (sent as null) into zero", () => {
    const s = fromWire({ cpu: null, memUsed: 1, memTotal: 2, rxPerSec: 3, txPerSec: null, sampledAt: 9 });
    expect(s).toEqual({ cpu: 0, memUsed: 1, memTotal: 2, rxPerSec: 3, txPerSec: 0, sampledAt: 9 });
  });
});

describe("clipboard", () => {
  it("copies through the clipboard plugin", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await tauriClipboard.copy("hi");
    expect(invoke).toHaveBeenLastCalledWith("plugin:clipboard|copy", { text: "hi" });
  });

  it("sends images as raw bytes, sized by headers", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    const image = { width: 2, height: 1, data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]) } as ImageData;
    await tauriClipboard.copyImage(image);
    const [command, body, options] = vi.mocked(invoke).mock.calls[0]!;
    expect(command).toBe("plugin:clipboard|copy_image");
    expect([...(body as Uint8Array)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(options).toEqual({ headers: { "x-width": "2", "x-height": "1" } });
  });
});

describe("volume", () => {
  it("targets the default output when no source is given", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await tauriVolume.setLevel(0.5);
    expect(invoke).toHaveBeenLastCalledWith("plugin:volume|set_level", { source: null, level: 0.5 });
    await tauriVolume.setMuted(true, "app:spotify");
    expect(invoke).toHaveBeenLastCalledWith("plugin:volume|set_muted", { source: "app:spotify", muted: true });
  });

  it("listens before reading, so no change is lost, and cleans up levels", async () => {
    const log: string[] = [];
    events(log, [{ level: null, muted: true, device: "Pushed" }]);
    vi.mocked(invoke).mockImplementation(async (command) => {
      log.push(`invoke ${command}`);
      return { level: 0.4, muted: false, device: "Read" };
    });
    const seen: unknown[] = [];
    const stop = await tauriVolume.watch((o) => seen.push(o));
    expect(log).toEqual(["listen plugin:volume:output-changed", "invoke plugin:volume|state"]);
    expect(seen).toEqual([
      { level: 0, muted: true, device: "Pushed" },
      { level: 0.4, muted: false, device: "Read" },
    ]);
    stop();
    expect(log.at(-1)).toBe("unlisten plugin:volume:output-changed");
  });

  it("keeps a missing output missing", () => expect(output(null)).toBeNull());
});

describe("dictation", () => {
  it("cleans up the listening level and time, and leaves other phases alone", () => {
    expect(phase({ phase: "listening", level: null, seconds: 3 })).toEqual({ phase: "listening", level: 0, seconds: 3 });
    const done = { phase: "done", text: "Hi", delivery: "copied" } as const;
    expect(phase(done)).toBe(done);
  });

  it("calls each command by its Rust name", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await tauriDictation.control("toggle");
    expect(invoke).toHaveBeenLastCalledWith("plugin:dictation|control", { command: "toggle" });
    await tauriDictation.download();
    expect(invoke).toHaveBeenLastCalledWith("plugin:dictation|download_model");
    await tauriDictation.remove();
    expect(invoke).toHaveBeenLastCalledWith("plugin:dictation|delete_model");
    await tauriDictation.openFolder();
    expect(invoke).toHaveBeenLastCalledWith("plugin:dictation|open_model_dir");
  });
});

describe("media", () => {
  it("stops listening when the first read fails", async () => {
    const log: string[] = [];
    events(log);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("backend gone"));
    await expect(tauriMedia.watch(() => {})).rejects.toThrow("backend gone");
    expect(log).toEqual(["listen plugin:media:track-changed", "unlisten plugin:media:track-changed"]);
  });
});

describe("capture", () => {
  const frame = (width: number, height: number, pixels: number) => {
    const buffer = new ArrayBuffer(8 + pixels);
    const view = new DataView(buffer);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    return buffer;
  };

  it("decodes the size header without copying the pixels", () => {
    const buffer = frame(2, 1, 8);
    const pixels = decode(buffer);
    expect(pixels && { width: pixels.width, height: pixels.height, bytes: pixels.rgba.byteLength }).toEqual({ width: 2, height: 1, bytes: 8 });
    expect(pixels?.rgba.buffer).toBe(buffer);
  });

  it("rejects empty or inconsistent captures", () => {
    expect(decode(new ArrayBuffer(0))).toBeNull();
    expect(decode(frame(0, 1, 0))).toBeNull();
    expect(decode(frame(2, 2, 8))).toBeNull();
  });

  it("names the file in a header and returns where it was saved", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("C:/Pictures/Island/a.png");
    expect(await tauriCapture.save(new Uint8Array([1]), "a.png")).toBe("C:/Pictures/Island/a.png");
    expect(invoke).toHaveBeenLastCalledWith("plugin:capture|save_png", new Uint8Array([1]), { headers: { "x-name": "a.png" } });
  });
});
