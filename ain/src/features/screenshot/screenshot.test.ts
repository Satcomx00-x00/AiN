// @vitest-environment happy-dom
/**
 * The screenshot plugin is a tool only: a shortcut that opens the editor on the latest capture,
 * read from the backend as a size header followed by the RGBA pixels.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const { screenshot } = await import(".");
const { editor } = await import("./editor");
const { tauriCapture } = await import("./service");

describe("the plugin", () => {
  it("adds no tab or glance, only the capture command, which opens the editor", () => {
    expect(screenshot.slots).toEqual([]);
    expect(screenshot.setup({} as never, {} as never)).toEqual({});
    expect(screenshot.commands?.map((c) => [c.id, c.shortcut, c.surface, c.popup])).toEqual([["capture", "Super+Alt+KeyS", "screen", editor]]);
  });
});

describe("the latest capture", () => {
  const frame = (width: number, height: number, rgba: number[]) => {
    const bytes = new Uint8Array(8 + rgba.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    bytes.set(rgba, 8);
    return bytes.buffer;
  };

  it("arrives as an image of the captured size and pixels", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(frame(1, 2, [1, 2, 3, 255, 4, 5, 6, 255]));
    const image = await tauriCapture.latest();
    expect(invoke).toHaveBeenLastCalledWith("plugin:capture|latest");
    expect(image && { width: image.width, height: image.height, data: [...image.data] }).toEqual({ width: 1, height: 2, data: [1, 2, 3, 255, 4, 5, 6, 255] });
  });

  it("is null when nothing was captured, or the pixels don't match the size", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(new ArrayBuffer(0));
    expect(await tauriCapture.latest()).toBeNull();
    vi.mocked(invoke).mockResolvedValueOnce(frame(0, 2, []));
    expect(await tauriCapture.latest()).toBeNull();
    vi.mocked(invoke).mockResolvedValueOnce(frame(2, 2, [1, 2, 3, 255]));
    expect(await tauriCapture.latest()).toBeNull();
  });
});

describe("saving", () => {
  it("sends the PNG's bytes with its name, and returns where it landed", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("C:/Pictures/AiN/shot.png");
    expect(await tauriCapture.save(new Uint8Array([137, 80]), "shot.png")).toBe("C:/Pictures/AiN/shot.png");
    expect(invoke).toHaveBeenLastCalledWith("plugin:capture|save_png", new Uint8Array([137, 80]), { headers: { "x-name": "shot.png" } });
  });
});
