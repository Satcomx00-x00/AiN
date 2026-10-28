// @vitest-environment happy-dom
/**
 * The capture tool: drag (or click) on the frozen screen to choose an area, draw on it with the
 * pen, highlighter and shapes, then copy or save the result. happy-dom has no 2D canvas, so every
 * canvas gets a fake context that records what is drawn on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardPort } from "../clipboard/service";
import { CRAYONS, editor } from "./editor";
import type { CapturePort } from "./service";

type Call = [string, ...unknown[]];

/** A 2D context that logs drawing calls since the last `clearRect`, with the style each stroke or fill used. */
class FakeContext {
  globalAlpha = 1;
  strokeStyle = "";
  fillStyle = "";
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  log: Call[] = [];
  readonly getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => new ImageData(w, h));
  readonly putImageData = vi.fn();
  readonly drawImage = vi.fn();
  constructor() {
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        void this.log.push([name, ...args]);
    const style = (name: string) => () => void this.log.push([name, { alpha: this.globalAlpha, color: name === "fill" ? this.fillStyle : this.strokeStyle, width: this.lineWidth }]);
    Object.assign(this, {
      clearRect: (...args: unknown[]) => (this.log = [["clearRect", ...args]]),
      beginPath: record("beginPath"),
      moveTo: record("moveTo"),
      lineTo: record("lineTo"),
      quadraticCurveTo: record("quadraticCurveTo"),
      arc: record("arc"),
      ellipse: record("ellipse"),
      roundRect: record("roundRect"),
      stroke: style("stroke"),
      fill: style("fill"),
    });
  }
}

let contexts: Map<HTMLCanvasElement, FakeContext>;
/** When false, canvases have no 2D context, as when the system runs out of canvas memory. */
let canvasWorks: boolean;
let pendingFrames: FrameRequestCallback[];
let blob: Blob | null;
const keyListeners: [string, EventListenerOrEventListenerObject, AddEventListenerOptions | boolean | undefined][] = [];

beforeEach(() => {
  contexts = new Map();
  canvasWorks = true;
  pendingFrames = [];
  blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => pendingFrames.push(cb));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (!canvasWorks) return null;
    const c = contexts.get(this) ?? new FakeContext();
    contexts.set(this, c);
    return c as never;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) => done(blob));
  // The editor listens on the document; keep each test's editor from hearing the next test's keys.
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
    keyListeners.push([type, fn, opts]);
    add(type, fn, opts);
  });
});

afterEach(() => {
  for (const [type, fn, opts] of keyListeners.splice(0)) document.removeEventListener(type, fn, opts);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(0);
/** Runs the animation frames the editor asked for. */
const frames = () => {
  for (const cb of pendingFrames.splice(0)) cb(0);
};
const mod = "Ctrl";

async function open(opts: { image?: ImageData | null; closeAfterCopy?: boolean; latest?: () => Promise<ImageData | null> } = {}) {
  const image = opts.image === undefined ? new ImageData(200, 100) : opts.image;
  const capture = { latest: vi.fn(opts.latest ?? (async () => image)), save: vi.fn(async (_png: Uint8Array, _name: string) => "C:/Pictures/AiN/shot.png") } satisfies CapturePort;
  const clipboard = { history: vi.fn(async () => []), copy: vi.fn(async () => {}), copyImage: vi.fn(async (_image: ImageData) => {}), clear: vi.fn(async () => {}) } satisfies ClipboardPort;
  const close = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);
  const view = editor(root, { services: { capture, clipboard }, options: () => ({ closeAfterCopy: opts.closeAfterCopy ?? true }), close, paste: async () => {}, commands: () => [], run: async () => {}, openSettings: async () => {}, quit: async () => {} });
  const el = <T extends Element>(selector: string) => root.querySelector(selector) as T;
  const base = el<HTMLCanvasElement>(".ed-base");
  const ink = el<HTMLCanvasElement>(".ed-ink");
  const stage = el<HTMLElement>(".ed-stage");
  const show = async () => {
    view.show();
    await settle();
  };
  await show();
  return {
    root,
    view,
    show,
    capture,
    clipboard,
    close,
    image,
    base,
    ink,
    stage,
    sheet: el<HTMLElement>(".ed-sheet"),
    dim: el<HTMLElement>(".ed-dim"),
    selection: el<HTMLElement>(".ed-area"),
    hint: el<HTMLElement>(".ed-hint"),
    bar: el<HTMLElement>(".ed-bar"),
    toast: el<HTMLElement>(".ed-toast"),
    empty: el<HTMLElement>(".ed-empty"),
    phase: () => stage.dataset.phase,
    /** What the ink layer shows after the next frame. */
    drawn: () => {
      frames();
      return contexts.get(ink)?.log.slice(1) ?? [];
    },
    button: (label: string) => [...root.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.title === label) as HTMLButtonElement,
  };
}

function pointer(target: Element, type: string, x = 0, y = 0, init: PointerEventInit = {}, coalesced?: (() => { clientX: number; clientY: number }[]) | undefined) {
  const e = new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y, ...init });
  if (arguments.length > 5) Object.defineProperty(e, "getCoalescedEvents", { value: coalesced });
  target.dispatchEvent(e);
}

/** A drag from `from` through `to` (each a point), released at the end. */
function drag(target: Element, ...points: [number, number, PointerEventInit?][]) {
  const [first, ...rest] = points;
  if (!first) return;
  pointer(target, "pointerdown", first[0], first[1]);
  for (const [x, y, init] of rest) pointer(target, "pointermove", x, y, init);
  pointer(target, "pointerup");
}

/** Presses a key; true when the editor handled it (so the host's own shortcut, like Esc to close, doesn't run). */
function press(code: string, init: KeyboardEventInit = {}): boolean {
  const e = new KeyboardEvent("keydown", { code, key: code, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(e);
  return e.defaultPrevented;
}

/** Opens the editor on a 50×30 crop at (10, 10). */
async function editing(opts: Parameters<typeof open>[0] = {}) {
  const ed = await open(opts);
  drag(ed.base, [10, 10], [60, 40]);
  return ed;
}

const pressed = (buttons: HTMLButtonElement[]) => buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"));
const TAU = Math.PI * 2;
const RED = CRAYONS[0][1];

describe("showing a capture", () => {
  it("shows the frozen screen, dimmed, with a hint, and takes focus", async () => {
    const ed = await open();
    expect(ed.phase()).toBe("select");
    expect(contexts.get(ed.base)?.putImageData).toHaveBeenLastCalledWith(ed.image, 0, 0);
    expect([ed.base.width, ed.base.height, ed.ink.width, ed.ink.height]).toEqual([200, 100, 200, 100]);
    expect([ed.dim.hidden, ed.selection.hidden, ed.hint.hidden, ed.bar.hidden, ed.empty.hidden, ed.stage.hidden]).toEqual([false, true, false, true, true, false]);
    expect(document.activeElement).toBe(ed.root);
    expect(ed.toast.dataset.on).toBe("false");
  });

  it("says there is nothing to edit when no capture was taken", async () => {
    const ed = await open({ image: null });
    expect([ed.empty.hidden, ed.stage.hidden]).toEqual([false, true]);
  });

  it("says there is nothing to edit when the capture can't be read", async () => {
    const ed = await open({ latest: async () => Promise.reject(new Error("gone")) });
    expect(ed.empty.hidden).toBe(false);
  });

  it("does nothing until a capture has arrived", async () => {
    const ed = await open({ latest: () => new Promise(() => {}) });
    ed.button("New selection (N)").click();
    expect(press("Enter")).toBe(true);
    expect(ed.phase()).toBe("select");
    expect(contexts.get(ed.base)).toBeUndefined();
  });

  it("starts over each time it is shown", async () => {
    const ed = await editing();
    pointer(ed.ink, "pointerdown", 5, 5);
    pointer(ed.ink, "pointerup");
    press("KeyC", { ctrlKey: true });
    await settle();
    expect(ed.toast.dataset.on).toBe("true");
    await ed.show();
    expect(ed.toast.dataset.on).toBe("false");
    expect(ed.phase()).toBe("select");
    expect(ed.drawn()).toEqual([]);
  });
});

describe("choosing an area", () => {
  it("frames the dragged area, undimmed, with its size", async () => {
    const ed = await open();
    pointer(ed.base, "pointerdown", 10, 10);
    // A press alone is no area yet: the whole screen stays dimmed.
    expect([ed.selection.hidden, ed.dim.hidden]).toEqual([true, false]);
    pointer(ed.base, "pointermove", 60, 40);
    expect([ed.selection.hidden, ed.dim.hidden]).toEqual([false, true]);
    expect([ed.selection.style.left, ed.selection.style.top, ed.selection.style.width, ed.selection.style.height]).toEqual(["10px", "10px", "50px", "30px"]);
    expect(ed.selection.textContent).toBe("50 × 30");
  });

  it("shows the frame in screen pixels and the size in image pixels on a zoomed screen", async () => {
    const ed = await open();
    Object.defineProperty(ed.base, "clientWidth", { value: 100 });
    pointer(ed.base, "pointerdown", 10, 10);
    pointer(ed.base, "pointermove", 40, 30);
    expect([ed.selection.style.left, ed.selection.style.width, ed.selection.style.height]).toEqual(["10px", "30px", "20px"]);
    expect(ed.selection.textContent).toBe("60 × 40");
  });

  it("keeps the area inside the screen", async () => {
    const ed = await open();
    pointer(ed.base, "pointerdown", 150, 50);
    pointer(ed.base, "pointermove", 400, -20);
    expect(ed.selection.textContent).toBe("50 × 50");
  });

  it("opens the editor on the area when released, sized to it", async () => {
    const ed = await editing();
    expect(ed.phase()).toBe("edit");
    expect(contexts.get(ed.base)?.getImageData).toHaveBeenCalledWith(10, 10, 50, 30);
    expect([ed.base.width, ed.base.height, ed.ink.width, ed.ink.height]).toEqual([50, 30, 50, 30]);
    expect([ed.sheet.style.width, ed.sheet.style.height]).toEqual(["50px", "30px"]);
    expect([ed.bar.hidden, ed.hint.hidden, ed.dim.hidden, ed.selection.hidden]).toEqual([false, true, true, true]);
  });

  it("takes the whole screen on a click, a drag too thin to be an area, or Enter", async () => {
    for (const choose of [
      (ed: { base: Element }) => drag(ed.base, [10, 10]),
      (ed: { base: Element }) => drag(ed.base, [10, 10], [60, 11]),
      () => press("Enter"),
    ]) {
      const ed = await open();
      choose(ed);
      expect(ed.phase()).toBe("edit");
      expect(contexts.get(ed.base)?.putImageData).toHaveBeenLastCalledWith(ed.image, 0, 0);
      expect([ed.sheet.style.width, ed.sheet.style.height]).toEqual(["200px", "100px"]);
    }
  });

  it("shrinks a capture larger than the window to fit it", async () => {
    const ed = await open({ image: new ImageData(2000, 1000) });
    press("Enter");
    expect([ed.sheet.style.width, ed.sheet.style.height]).toEqual(["960px", "480px"]);
  });

  it("cancels a drag with Esc, and leaves Esc to close the tool otherwise", async () => {
    const ed = await open();
    pointer(ed.base, "pointerdown", 10, 10);
    pointer(ed.base, "pointermove", 60, 40);
    expect(press("Escape")).toBe(true);
    expect([ed.selection.hidden, ed.dim.hidden]).toEqual([true, false]);
    pointer(ed.base, "pointerup");
    expect(ed.phase()).toBe("select");
    expect(press("Escape")).toBe(false);
  });

  it("drops the drag when the pointer is lost", async () => {
    const ed = await open();
    pointer(ed.base, "pointerdown", 10, 10);
    pointer(ed.base, "pointermove", 60, 40);
    pointer(ed.base, "pointercancel");
    expect(ed.selection.hidden).toBe(true);
    pointer(ed.base, "pointerup");
    expect(ed.phase()).toBe("select");
  });

  it("ignores other mouse buttons and the editor's shortcuts", async () => {
    const ed = await open();
    pointer(ed.base, "pointerdown", 10, 10, { button: 2 });
    pointer(ed.base, "pointermove", 60, 40);
    expect(ed.selection.hidden).toBe(true);
    expect(press("KeyP")).toBe(false);
    expect(press("KeyC", { ctrlKey: true })).toBe(false);
    expect(ed.phase()).toBe("select");
  });

  it("stays on the selection when the area can't be cropped", async () => {
    canvasWorks = false;
    const ed = await open();
    expect(ed.drawn()).toEqual([]);
    drag(ed.base, [10, 10], [60, 40]);
    expect(ed.phase()).toBe("select");
    // The whole screen needs no cropping.
    press("Enter");
    expect(ed.phase()).toBe("edit");
  });

  it("goes back to choosing an area with N or the toolbar, dropping the drawings", async () => {
    for (const reselect of [() => press("KeyN"), (ed: { button: (l: string) => HTMLButtonElement }) => ed.button("New selection (N)").click()]) {
      const ed = await editing();
      drag(ed.ink, [5, 5]);
      reselect(ed);
      expect(ed.phase()).toBe("select");
      expect([ed.bar.hidden, ed.hint.hidden, ed.dim.hidden]).toEqual([true, false, false]);
      expect([ed.sheet.style.width, ed.base.width]).toEqual(["", 200]);
      expect(contexts.get(ed.base)?.putImageData).toHaveBeenLastCalledWith(ed.image, 0, 0);
      expect(ed.drawn()).toEqual([]);
    }
  });
});

describe("drawing", () => {
  it("draws a smooth pen line through the dragged points", async () => {
    const ed = await editing();
    drag(ed.ink, [5, 5], [10, 8], [20, 12], [30, 10]);
    expect(ed.drawn()).toEqual([
      ["beginPath"],
      ["moveTo", 5, 5],
      ["quadraticCurveTo", 10, 8, 15, 10],
      ["quadraticCurveTo", 20, 12, 25, 11],
      ["lineTo", 30, 10],
      ["stroke", { alpha: 1, color: RED, width: 6 }],
    ]);
    const ink = contexts.get(ed.ink);
    expect([ink?.lineCap, ink?.lineJoin]).toEqual(["round", "round"]);
  });

  it("leaves a dot on a tap", async () => {
    const ed = await editing();
    drag(ed.ink, [5, 5]);
    expect(ed.drawn()).toEqual([["beginPath"], ["arc", 5, 5, 3, 0, TAU], ["fill", { alpha: 1, color: RED, width: 6 }]]);
  });

  it("shows a line while it is drawn, redrawing at most once a frame", async () => {
    const ed = await editing();
    frames();
    pointer(ed.ink, "pointerdown", 5, 5);
    pointer(ed.ink, "pointermove", 9, 5);
    pointer(ed.ink, "pointermove", 12, 5);
    expect(pendingFrames).toHaveLength(1);
    expect(ed.drawn()).toContainEqual(["lineTo", 12, 5]);
  });

  it("drops the line being drawn when the pointer is lost", async () => {
    const ed = await editing();
    pointer(ed.ink, "pointerdown", 5, 5);
    pointer(ed.ink, "pointermove", 9, 5);
    pointer(ed.ink, "pointercancel");
    pointer(ed.ink, "pointerup");
    expect(ed.drawn()).toEqual([]);
  });

  it("follows every point of a fast stroke, or the event itself when the browser gives none", async () => {
    const ed = await editing();
    pointer(ed.ink, "pointerdown", 0, 0);
    pointer(ed.ink, "pointermove", 9, 9, {}, () => [
      { clientX: 2, clientY: 1 },
      { clientX: 4, clientY: 2 },
    ]);
    pointer(ed.ink, "pointermove", 6, 3, {}, () => []);
    pointer(ed.ink, "pointermove", 8, 4, {}, undefined);
    pointer(ed.ink, "pointerup");
    expect(ed.drawn()).toEqual([
      ["beginPath"],
      ["moveTo", 0, 0],
      ["quadraticCurveTo", 2, 1, 3, 1.5],
      ["quadraticCurveTo", 4, 2, 5, 2.5],
      ["quadraticCurveTo", 6, 3, 7, 3.5],
      ["lineTo", 8, 4],
      ["stroke", { alpha: 1, color: RED, width: 6 }],
    ]);
  });

  it("draws in image pixels, as wide on screen whatever the zoom", async () => {
    const ed = await editing();
    Object.defineProperty(ed.base, "clientWidth", { value: 25 });
    drag(ed.ink, [5, 5]);
    expect(ed.drawn()).toEqual([["beginPath"], ["arc", 10, 10, 6, 0, TAU], ["fill", { alpha: 1, color: RED, width: 12 }]]);
  });

  it("highlights with a wide, translucent stroke", async () => {
    const ed = await editing();
    expect(press("KeyH")).toBe(true);
    drag(ed.ink, [5, 5], [20, 5]);
    expect(ed.drawn()).toEqual([["beginPath"], ["moveTo", 5, 5], ["lineTo", 20, 5], ["stroke", { alpha: 0.35, color: RED, width: 18 }]]);
  });

  it("draws a rectangle from the drag, keeping only its last corner", async () => {
    const ed = await editing();
    press("KeyR");
    drag(ed.ink, [10, 10], [40, 25], [30, 20]);
    expect(ed.drawn()).toEqual([["beginPath"], ["roundRect", 10, 10, 20, 10, 5], ["stroke", { alpha: 1, color: RED, width: 6 }]]);
  });

  it("draws a square with Shift, in any direction", async () => {
    const ed = await editing();
    press("KeyR");
    drag(ed.ink, [10, 10], [30, 20, { shiftKey: true }]);
    drag(ed.ink, [10, 10], [10, 25, { shiftKey: true }]);
    drag(ed.ink, [10, 10], [-8, 10, { shiftKey: true }]);
    expect(ed.drawn().filter(([op]) => op === "roundRect")).toEqual([
      ["roundRect", 10, 10, 20, 20, 6],
      ["roundRect", 10, 10, 15, 15, 6],
      ["roundRect", -8, 10, 18, 18, 6],
    ]);
  });

  it("draws an ellipse inside the dragged box", async () => {
    const ed = await editing();
    press("KeyO");
    drag(ed.ink, [30, 20], [10, 10]);
    expect(ed.drawn()).toEqual([["beginPath"], ["ellipse", 20, 15, 10, 5, 0, 0, TAU], ["stroke", { alpha: 1, color: RED, width: 6 }]]);
  });

  it("shows a shape from the moment it is pressed", async () => {
    const ed = await editing();
    press("KeyO");
    pointer(ed.ink, "pointerdown", 10, 10);
    expect(ed.drawn()).toEqual([["beginPath"], ["ellipse", 10, 10, 0, 0, 0, 0, TAU], ["stroke", { alpha: 1, color: RED, width: 6 }]]);
  });

  it("drops a shape that is only a click", async () => {
    const ed = await editing();
    press("KeyR");
    drag(ed.ink, [10, 10]);
    drag(ed.ink, [10, 10], [11, 12]);
    expect(ed.drawn()).toEqual([]);
  });

  it("only draws on the picture, with the main button", async () => {
    const ed = await editing();
    frames();
    pointer(ed.stage, "pointermove", 20, 20);
    expect(pendingFrames).toHaveLength(0);
    drag(ed.stage, [5, 5], [20, 5]);
    pointer(ed.ink, "pointerdown", 5, 5, { button: 2 });
    pointer(ed.ink, "pointermove", 20, 5);
    pointer(ed.ink, "pointerup");
    expect(ed.drawn()).toEqual([]);
  });

  it("undoes the last drawing with the shortcut or the toolbar, and clears them all", async () => {
    const ed = await editing();
    drag(ed.ink, [1, 1]);
    drag(ed.ink, [2, 2]);
    drag(ed.ink, [3, 3]);
    expect(press("KeyZ", { ctrlKey: true })).toBe(true);
    expect(ed.drawn().filter(([op]) => op === "arc")).toEqual([
      ["arc", 1, 1, 3, 0, TAU],
      ["arc", 2, 2, 3, 0, TAU],
    ]);
    press("KeyZ", { ctrlKey: true });
    expect(ed.drawn().filter(([op]) => op === "arc")).toEqual([["arc", 1, 1, 3, 0, TAU]]);
    drag(ed.ink, [4, 4]);
    ed.button(`Undo (${mod}+Z)`).click();
    expect(ed.drawn().filter(([op]) => op === "arc")).toEqual([["arc", 1, 1, 3, 0, TAU]]);
    drag(ed.ink, [5, 5]);
    ed.button("Clear drawings").click();
    expect(ed.drawn()).toEqual([]);
  });
});

describe("the toolbar", () => {
  it("marks the chosen tool, color and size", async () => {
    const ed = await editing();
    const tools = [...ed.root.querySelectorAll<HTMLButtonElement>("[data-tool]")];
    const swatches = [...ed.root.querySelectorAll<HTMLButtonElement>(".ed-swatch")];
    const sizes = [...ed.root.querySelectorAll<HTMLButtonElement>(".ed-size")];
    expect([pressed(tools), pressed(swatches), pressed(sizes), ed.stage.dataset.tool]).toEqual([["Pen (P)"], ["Red (1)"], ["Medium"], "pen"]);
    ed.button("Ellipse (O) — hold Shift for a circle").click();
    ed.button("Blue (5)").click();
    ed.button("Thick").click();
    expect([pressed(tools), pressed(swatches), pressed(sizes), ed.stage.dataset.tool]).toEqual([["Ellipse (O) — hold Shift for a circle"], ["Blue (5)"], ["Thick"], "ellipse"]);
    expect(swatches.map((b) => b.style.getPropertyValue("--c"))).toEqual(CRAYONS.map(([, value]) => value));
    expect(sizes.map((b) => b.style.getPropertyValue("--s"))).toEqual(["5px", "8px", "14px"]);
  });

  it("draws with the chosen color and size", async () => {
    const ed = await editing();
    ed.button("Highlighter (H)").click();
    ed.button("Rectangle (R) — hold Shift for a square").click();
    ed.button("Pen (P)").click();
    ed.button("Green (4)").click();
    ed.button("Thin").click();
    drag(ed.ink, [5, 5]);
    expect(ed.drawn()).toEqual([["beginPath"], ["arc", 5, 5, 1.5, 0, TAU], ["fill", { alpha: 1, color: "#34c759", width: 3 }]]);
  });

  it("picks tools with letters and colors with digits", async () => {
    const ed = await editing();
    const tool = () => ed.stage.dataset.tool;
    const steps = (["KeyH", "KeyR", "KeyO", "KeyP"] as const).map((code) => (press(code), tool()));
    expect(steps).toEqual(["marker", "rect", "ellipse", "pen"]);
    expect(press("Digit3")).toBe(true);
    expect(press("Digit8")).toBe(true);
    drag(ed.ink, [5, 5]);
    expect(ed.drawn()).toContainEqual(["fill", { alpha: 1, color: "#1c1c1e", width: 6 }]);
  });

  it("leaves other keys, and letters with Ctrl, to the system", async () => {
    await editing();
    expect(press("KeyQ")).toBe(false);
    expect(press("Digit9")).toBe(false);
    expect(press("KeyP", { ctrlKey: true })).toBe(false);
    expect(press("Digit2", { ctrlKey: true })).toBe(false);
  });

  it("closes", async () => {
    const ed = await editing();
    ed.button("Close (Esc)").click();
    expect(ed.close).toHaveBeenCalledOnce();
  });
});

describe("copying", () => {
  it("copies the picture with its drawings, says so, and closes", async () => {
    const ed = await editing();
    drag(ed.ink, [5, 5]);
    expect(press("KeyC", { ctrlKey: true })).toBe(true);
    await settle();
    const [out, c] = [...contexts].find(([canvas]) => !ed.root.contains(canvas)) ?? [];
    expect([out?.width, out?.height]).toEqual([50, 30]);
    expect(c?.drawImage.mock.calls).toEqual([
      [ed.base, 0, 0],
      [ed.ink, 0, 0],
    ]);
    expect(c?.getImageData).toHaveBeenCalledWith(0, 0, 50, 30);
    expect(ed.clipboard.copyImage).toHaveBeenCalledWith(c?.getImageData.mock.results[0]?.value);
    expect([ed.toast.textContent, ed.toast.dataset.on]).toEqual([`Copied — paste it anywhere with ${mod}+V`, "true"]);
    await vi.advanceTimersByTimeAsync(649);
    expect(ed.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ed.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ed.toast.dataset.on).toBe("false");
  });

  it("stays open after copying when told to, from the toolbar too", async () => {
    const ed = await editing({ closeAfterCopy: false });
    ed.button(`Copy (${mod}+C)`).click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ed.clipboard.copyImage).toHaveBeenCalledOnce();
    expect(ed.close).not.toHaveBeenCalled();
  });

  it("says why copying failed, and stays open", async () => {
    const ed = await editing();
    ed.clipboard.copyImage.mockRejectedValueOnce(new Error("Clipboard busy"));
    press("KeyC", { ctrlKey: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ed.toast.textContent).toBe("Couldn't copy: Error: Clipboard busy");
    expect(ed.close).not.toHaveBeenCalled();
  });

  it("copies nothing while an area is being chosen, or when the picture can't be read", async () => {
    const ed = await open();
    ed.button(`Copy (${mod}+C)`).click();
    await settle();
    drag(ed.base, [10, 10], [60, 40]);
    canvasWorks = false;
    press("KeyC", { ctrlKey: true });
    await settle();
    expect(ed.clipboard.copyImage).not.toHaveBeenCalled();
    expect(ed.toast.textContent).toBe("");
  });
});

describe("saving", () => {
  it("saves a PNG named after the time, and says where", async () => {
    vi.setSystemTime(new Date(2026, 9, 14, 23, 5, 7));
    const ed = await editing();
    expect(press("KeyS", { ctrlKey: true })).toBe(true);
    await settle();
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(ed.capture.save).toHaveBeenCalledWith(new Uint8Array([137, 80, 78, 71]), "Screenshot 2026-10-14 at 23.05.07.png");
    expect(ed.toast.textContent).toBe("Saved to C:/Pictures/AiN/shot.png");
    expect(ed.close).not.toHaveBeenCalled();
  });

  it("says why saving failed", async () => {
    const ed = await editing();
    ed.capture.save.mockRejectedValueOnce(new Error("Disk full"));
    ed.button(`Save as PNG (${mod}+S)`).click();
    await settle();
    expect(ed.toast.textContent).toBe("Couldn't save: Error: Disk full");
  });

  it("saves nothing while an area is being chosen, or when the picture can't be encoded", async () => {
    const ed = await open();
    ed.button(`Save as PNG (${mod}+S)`).click();
    await settle();
    drag(ed.base, [10, 10], [60, 40]);
    blob = null;
    press("KeyS", { ctrlKey: true });
    await settle();
    expect(ed.capture.save).not.toHaveBeenCalled();
    expect(ed.toast.textContent).toBe("");
  });

  it("keeps a new message up for its full time", async () => {
    const ed = await editing();
    press("KeyS", { ctrlKey: true });
    await vi.advanceTimersByTimeAsync(1000);
    ed.capture.save.mockResolvedValueOnce("C:/Pictures/AiN/second.png");
    press("KeyS", { ctrlKey: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect([ed.toast.textContent, ed.toast.dataset.on]).toEqual(["Saved to C:/Pictures/AiN/second.png", "true"]);
    await vi.advanceTimersByTimeAsync(600);
    expect(ed.toast.dataset.on).toBe("false");
  });
});
