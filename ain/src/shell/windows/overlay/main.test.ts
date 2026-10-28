// @vitest-environment happy-dom
/**
 * The capture overlay's entry point: it hosts the commands' views full screen, against the app's
 * backend inside Tauri, and in the browser preview against a generated picture, with a demo that
 * drives the editor as a user would.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SurfaceOptions } from "../../surface";
import type { Services } from "../../../features/services";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const hostCommands = vi.fn<(options: SurfaceOptions) => void>();
vi.mock("../../surface", () => ({ hostCommands }));

/**
 * Loads a fresh copy of the overlay's script at `search`, in the app or in the preview; resolves
 * with what it hosts, and the modules it was given them from (fresh copies too).
 */
async function load({ inApp = false, search = "" } = {}) {
  hostCommands.mockClear();
  history.replaceState(null, "", `/${search}`);
  if (inApp) Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.resetModules();
  await import("./main");
  const options: SurfaceOptions = hostCommands.mock.calls[0]![0];
  return {
    options,
    services: options.services as Services,
    ...(await import("../../commands")),
    ...(await import("../../settings")),
    ...(await import("../../../features/services")),
    ...(await import("../../../features")),
    layout: (await import("../../../features/layout")).layout,
  };
}

/** A 2D context that records what is drawn on it. */
function recordingContext() {
  const drawn: string[] = [];
  const g = {
    fillStyle: "" as unknown,
    font: "",
    createLinearGradient: () => ({ addColorStop: (at: number, color: string) => void drawn.push(`stop ${at} ${color}`) }),
    fillRect: (x: number, y: number, w: number, h: number) => void drawn.push(`rect ${[x, y, w, h].map(Math.round).join(" ")}`),
    fillText: (text: string) => void drawn.push(`text ${text}`),
    getImageData: (_x: number, _y: number, w: number, h: number) => new ImageData(w, h),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(g as never);
  return drawn;
}

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the capture overlay", () => {
  it("hosts every built-in command in a surface filling its page", async () => {
    const { options, catalogue, layout } = await load();
    expect(hostCommands).toHaveBeenCalledTimes(1);
    expect(options.container.className).toBe("surface");
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

  it("in the preview, edits a generated picture of the screen, at the screen's pixel size", async () => {
    const drawn = recordingContext();
    const { options, services, idlePopup, tauriSettings } = await load();
    expect(options.popup).toBe(idlePopup);
    expect(options.store).not.toBe(tauriSettings);
    const picture = await services.capture.latest();
    expect([picture?.width, picture?.height]).toEqual([Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)]);
    expect(drawn).toEqual([
      "stop 0 #3a5a8c",
      "stop 1 #11151f",
      `rect 0 0 ${picture?.width} ${picture?.height}`,
      `rect ${[0.18 * picture!.width, 0.3 * picture!.height, 0.5 * picture!.width, 0.42 * picture!.height].map(Math.round).join(" ")}`,
      "text A window you want to show someone",
    ]);
  });

  it("in the preview, hands back a blank picture where canvases can't draw", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { services } = await load();
    const picture = await services.capture.latest();
    expect([picture?.width, picture?.height]).toEqual([1, 1]);
  });

  it("in the preview, pretends to save and copy, touching nothing", async () => {
    const { services, tauriServices } = await load();
    expect(await services.capture.save(new Uint8Array(), "capture.png")).toBe("C:\\Users\\you\\Pictures\\AiN\\capture.png");
    expect(await services.capture.problem()).toBeNull();
    await expect(services.clipboard.copyImage(new ImageData(1, 1))).resolves.toBeUndefined();
    expect(services.clipboard.history).toBe(tauriServices.clipboard.history);
    expect(services.stats).toBe(tauriServices.stats);
  });
});

describe("the preview's demo", () => {
  /** The editor's stage with a picture on its left half; records the pointer events reaching it. */
  function stage() {
    const el = document.createElement("div");
    el.className = "ed-stage";
    const picture = document.createElement("canvas");
    el.append(picture);
    document.body.append(el);
    // As a real page would, a point finds what's under it: the picture on the left, else nothing.
    vi.spyOn(document, "elementFromPoint").mockImplementation((x) => (x <= innerWidth / 2 ? picture : null));
    const events: { type: string; on: "picture" | "stage"; x: number; y: number }[] = [];
    for (const type of ["pointerdown", "pointermove", "pointerup"])
      el.addEventListener(type, (e) => {
        const p = e as PointerEvent;
        events.push({ type, on: p.target === picture ? "picture" : "stage", x: p.clientX, y: p.clientY });
      });
    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(`${e.code}:${e.key}`));
    return { events, keys };
  }
  const at = (x: number, y: number) => ({ x: innerWidth * x, y: innerHeight * y });

  it("drags out an area, then scribbles on it with other colors and tools", async () => {
    vi.useFakeTimers();
    const { events, keys } = stage();
    await load({ search: "?demo" });
    await vi.advanceTimersByTimeAsync(300);
    // The selection: pressed on the picture, released over the backdrop.
    expect(events.slice(0, 4)).toEqual([
      { type: "pointerdown", on: "picture", ...at(0.16, 0.26) },
      { type: "pointermove", on: "picture", ...at(0.5, 0.5) },
      { type: "pointermove", on: "stage", ...at(0.71, 0.76) },
      { type: "pointerup", on: "stage", ...at(0.71, 0.76) },
    ]);
    expect(keys).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    const strokes = events.slice(4).map((e) => e.type).join(" ").split(" pointerup").filter(Boolean);
    expect(strokes.map((s) => s.trim().split(" ").length)).toEqual([40, 3, 3]);
    expect(events.filter((e) => e.type === "pointerup")).toHaveLength(4);
    expect(keys).toEqual(["Digit5:5", "KeyR:r", "Digit4:4"]);
  });

  it("stops mid-drag with ?demo=select, to show the selection step", async () => {
    vi.useFakeTimers();
    const { events, keys } = stage();
    await load({ search: "?demo=select" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.map((e) => e.type)).toEqual(["pointerdown", "pointermove", "pointermove"]);
    expect(keys).toEqual([]);
  });

  it("does nothing when the editor isn't on screen", async () => {
    vi.useFakeTimers();
    const pointer = vi.fn();
    document.addEventListener("pointerdown", pointer);
    await load({ search: "?demo" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pointer).not.toHaveBeenCalled();
    document.removeEventListener("pointerdown", pointer);
  });

  it("doesn't run without ?demo, nor inside the app", async () => {
    vi.useFakeTimers();
    const { events } = stage();
    await load();
    await vi.advanceTimersByTimeAsync(1000);
    await load({ inApp: true, search: "?demo" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([]);
  });
});
