import { button, h, icon } from "../../sdk/dom";
import { primaryKey } from "../../sdk/platform";
import type { PopupContext, PopupView } from "../../sdk/plugin";
import type { ClipboardPort } from "../clipboard/service";
import type { CapturePort } from "./service";

export type Tool = "pen" | "marker" | "rect" | "ellipse";
type Point = readonly [number, number];

/** First choose what to capture, then annotate it. */
type Phase = "select" | "edit";

/** Something drawn: a freehand path, or a shape spanning its first and last point. */
export interface Stroke {
  readonly tool: Tool;
  readonly color: string;
  /** In image pixels. */
  readonly width: number;
  readonly points: Point[];
}

const isShape = (tool: Tool): tool is "rect" | "ellipse" => tool === "rect" || tool === "ellipse";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const CRAYONS = [
  ["Red", "#ff3b30"],
  ["Orange", "#ff9500"],
  ["Yellow", "#ffcc00"],
  ["Green", "#34c759"],
  ["Blue", "#0a84ff"],
  ["Purple", "#af52de"],
  ["White", "#ffffff"],
  ["Black", "#1c1c1e"],
] as const;
/** Pen widths in CSS pixels; the highlighter draws 3× wider and translucent. */
const SIZES = [3, 6, 12] as const;
const MARKER_ALPHA = 0.35;
const MARKER_SCALE = 3;
/** Shapes smaller than this (image pixels) are a click, not a drag, and are dropped. */
const MIN_SHAPE = 3;
/** A selection smaller than this (image pixels) counts as a click: capture the whole screen. */
const MIN_AREA = 8;
/** Room kept around the crop while editing: toolbar above, breathing space around. */
const EDIT_TOP = 76;
const EDIT_MARGIN = 32;
const TOAST_MS = 1600;

/** Where a shape's dragged corner lands; with `square`, its sides are made equal (a square or a circle). */
export function shapeEnd(from: Point, to: Point, square: boolean): Point {
  if (!square) return to;
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + Math.sign(dx || 1) * side, from[1] + Math.sign(dy || 1) * side];
}

/** A rectangle from two corners, in either order, clamped to the image. */
export function rectFrom(a: Point, b: Point, width: number, height: number): Rect {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const [x1, y1, x2, y2] = [clamp(a[0], width), clamp(a[1], height), clamp(b[0], width), clamp(b[1], height)];
  return { x: Math.round(Math.min(x1, x2)), y: Math.round(Math.min(y1, y2)), w: Math.round(Math.abs(x2 - x1)), h: Math.round(Math.abs(y2 - y1)) };
}

/** The selection to crop to, or null for the whole screen when it's too small to be a drag. */
export const chosenArea = (area: Rect | null): Rect | null => (area && area.w >= MIN_AREA && area.h >= MIN_AREA ? area : null);

/** CSS size that shows an image at its real size, shrunk (never enlarged) to fit the room available. */
export function fitSize(width: number, height: number, dpr: number, room: { w: number; h: number }): { w: number; h: number } {
  const [w, hgt] = [width / dpr, height / dpr];
  const k = Math.min(1, room.w / w, room.h / hgt);
  return { w: Math.round(w * k), h: Math.round(hgt * k) };
}

/** "Screenshot 2026-10-14 at 23.05.07.png" in local time. */
export function fileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `Screenshot ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.png`;
}

/** Outlines a rectangle or ellipse between the stroke's first and last point. */
function outline(ctx: CanvasRenderingContext2D, s: Stroke) {
  const [a, b] = [s.points[0], s.points[s.points.length - 1]];
  if (!a || !b) return;
  const [x, y, w, h] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
  ctx.beginPath();
  if (s.tool === "ellipse") ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.roundRect(x, y, w, h, Math.min(s.width, w / 2, h / 2));
  ctx.stroke();
}

/** Draws a stroke: shapes as outlines, paths smoothly through their points (quadratic curves via midpoints). */
function trace(ctx: CanvasRenderingContext2D, s: Stroke) {
  const [first, ...rest] = s.points;
  if (!first) return;
  ctx.globalAlpha = s.tool === "marker" ? MARKER_ALPHA : 1;
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  if (isShape(s.tool)) return outline(ctx, s);
  if (!rest.length) {
    // A tap leaves a dot.
    ctx.beginPath();
    ctx.arc(first[0], first[1], s.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (let i = 0; i < rest.length - 1; i++) {
    const [p, q] = [rest[i], rest[i + 1]];
    if (p && q) ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  const last = rest[rest.length - 1];
  if (last) ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

const ICONS = {
  pen: `<path d="M3 13l1-3.5 7.5-7.5 2.5 2.5L6.5 12z"/><path d="M10 3.5l2.5 2.5"/>`,
  marker: `<path d="M4 11.5l6.5-6.5 2 2L6 13.5H4z"/><path d="M2.5 14h11"/>`,
  rect: `<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/>`,
  ellipse: `<ellipse cx="8" cy="8" rx="5.75" ry="4.75"/>`,
  reselect: `<path d="M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11"/>`,
  undo: `<path d="M5.5 4L2.5 7l3 3"/><path d="M2.5 7H10a3.5 3.5 0 0 1 0 7H8"/>`,
  clear: `<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.75 9h5.5l.75-9"/>`,
  copy: `<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>`,
  save: `<path d="M8 2.5v8M4.75 7.5L8 10.75l3.25-3.25"/><path d="M2.75 12.5v1h10.5v-1"/>`,
  close: `<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>`,
} as const;

type Ctx = PopupContext<{ capture: CapturePort; clipboard: ClipboardPort }, { closeAfterCopy: boolean }>;

/**
 * The capture tool. First the frozen screen: drag to choose an area (a click takes everything);
 * releasing the mouse opens the editor on that area to draw on it, then Ctrl+C copies the result.
 */
export function editor(root: HTMLElement, ctx: Ctx): PopupView {
  let phase: Phase = "select";
  let full: ImageData | null = null;
  let tool: Tool = "pen";
  let color: string = CRAYONS[0][1];
  let size: number = SIZES[1];
  let strokes: Stroke[] = [];
  let drawing: Stroke | null = null;
  let area: Rect | null = null;
  let anchor: Point | null = null;
  let frame = 0;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const base = h("canvas", { class: "ed-base" });
  const ink = h("canvas", { class: "ed-ink" });
  const sheet = h("div", { class: "ed-sheet" }, base, ink);
  const dim = h("div", { class: "ed-dim", "aria-hidden": "true" });
  const selection = h("div", { class: "ed-area", hidden: "" }, h("span", { class: "ed-area-size" }));
  const hint = h("div", { class: "ed-hint", role: "status" }, "Drag to capture an area · Click for the whole screen · Esc to cancel");
  const stage = h("div", { class: "ed-stage", "data-phase": phase }, sheet, dim, selection, hint);
  const toast = h("div", { class: "ed-toast", role: "status", "aria-live": "polite" });
  const empty = h("p", { class: "ed-empty", hidden: "" }, "No capture to edit.");

  /** Image pixels per CSS pixel, so strokes look the same whatever the zoom. */
  const scale = () => (base.clientWidth ? base.width / base.clientWidth : 1);
  const toImage = (e: PointerEvent): Point => {
    const r = base.getBoundingClientRect();
    return [(e.clientX - r.left) * scale(), (e.clientY - r.top) * scale()];
  };

  const redraw = () => {
    frame = 0;
    const c = ink.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, ink.width, ink.height);
    c.lineCap = c.lineJoin = "round";
    for (const s of drawing ? [...strokes, drawing] : strokes) trace(c, s);
  };
  const schedule = () => (frame ||= requestAnimationFrame(redraw));

  const showArea = () => {
    selection.hidden = !area || area.w < 2 || area.h < 2;
    // Before a drag the whole screen is dimmed; during one, everything but the area is.
    dim.hidden = phase !== "select" || !selection.hidden;
    if (!area || selection.hidden) return;
    const k = scale();
    Object.assign(selection.style, { left: `${area.x / k}px`, top: `${area.y / k}px`, width: `${area.w / k}px`, height: `${area.h / k}px` });
    const label = selection.firstElementChild;
    if (label) label.textContent = `${area.w} × ${area.h}`;
  };

  const say = (text: string) => {
    toast.textContent = text;
    toast.dataset.on = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.dataset.on = "false"), TOAST_MS);
  };

  const paintImage = (image: ImageData) => {
    base.width = ink.width = image.width;
    base.height = ink.height = image.height;
    base.getContext("2d")?.putImageData(image, 0, 0);
    schedule();
  };

  // ---------- phases ----------

  /** The frozen full screen, waiting for an area. */
  const startSelect = () => {
    if (!full) return;
    phase = "select";
    stage.dataset.phase = phase;
    bar.hidden = true;
    hint.hidden = false;
    strokes = [];
    drawing = null;
    area = null;
    anchor = null;
    sheet.style.width = sheet.style.height = "";
    paintImage(full);
    showArea();
  };

  /** Crops to `r` (null keeps the whole screen) and opens the editor on it, centered. */
  const startEdit = (r: Rect | null) => {
    if (!full) return;
    const image = r ? base.getContext("2d")?.getImageData(r.x, r.y, r.w, r.h) : full;
    if (!image) return;
    phase = "edit";
    stage.dataset.phase = phase;
    area = null;
    anchor = null;
    hint.hidden = true;
    bar.hidden = false;
    paintImage(image);
    const fit = fitSize(image.width, image.height, devicePixelRatio, { w: innerWidth - 2 * EDIT_MARGIN, h: innerHeight - EDIT_TOP - EDIT_MARGIN });
    sheet.style.width = `${fit.w}px`;
    sheet.style.height = `${fit.h}px`;
    showArea();
    setTool(tool);
  };

  // ---------- output ----------

  /** The edited image with its drawings. */
  const compose = (): HTMLCanvasElement => {
    const out = h("canvas");
    out.width = base.width;
    out.height = base.height;
    const c = out.getContext("2d");
    c?.drawImage(base, 0, 0);
    c?.drawImage(ink, 0, 0);
    return out;
  };

  const copy = async () => {
    if (phase !== "edit") return;
    const out = compose();
    const image = out.getContext("2d")?.getImageData(0, 0, out.width, out.height);
    if (!image) return;
    try {
      await ctx.services.clipboard.copyImage(image);
      say(`Copied — paste it anywhere with ${primaryKey()}+V`);
      if (ctx.options().closeAfterCopy) setTimeout(() => ctx.close(), 650);
    } catch (e) {
      say(`Couldn't copy: ${String(e)}`);
    }
  };

  const save = async () => {
    if (phase !== "edit") return;
    const blob = await new Promise<Blob | null>((done) => compose().toBlob(done, "image/png"));
    if (!blob) return;
    try {
      const path = await ctx.services.capture.save(new Uint8Array(await blob.arrayBuffer()), fileName(new Date()));
      say(`Saved to ${path}`);
    } catch (e) {
      say(`Couldn't save: ${String(e)}`);
    }
  };

  const clear = () => {
    strokes = [];
    schedule();
  };

  const undo = () => {
    strokes = strokes.slice(0, -1);
    schedule();
  };

  // ---------- toolbar ----------

  const TOOL_NAMES: Record<Tool, string> = {
    pen: "Pen (P)",
    marker: "Highlighter (H)",
    rect: "Rectangle (R) — hold Shift for a square",
    ellipse: "Ellipse (O) — hold Shift for a circle",
  };
  const toolButtons = (["pen", "marker", "rect", "ellipse"] as const).map((t) =>
    button(icon(ICONS[t]), () => setTool(t), { class: "ed-btn", "data-tool": t, "aria-label": TOOL_NAMES[t], title: TOOL_NAMES[t] }),
  );
  const swatches = CRAYONS.map(([name, value], i) => {
    const b = button("", () => setColor(value), { class: "ed-swatch", "aria-label": `${name} (${i + 1})`, title: `${name} (${i + 1})` });
    b.style.setProperty("--c", value);
    return b;
  });
  const sizeButtons = SIZES.map((s, i) => {
    const b = button(h("i"), () => setSize(s), { class: "ed-size", "aria-label": ["Thin", "Medium", "Thick"][i] ?? "Size" });
    b.style.setProperty("--s", `${s + 2}px`);
    return b;
  });

  const paint = () => {
    stage.dataset.tool = tool;
    for (const b of toolButtons) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
    swatches.forEach((b, i) => b.setAttribute("aria-pressed", String(CRAYONS[i]?.[1] === color)));
    sizeButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(SIZES[i] === size)));
  };
  const setTool = (t: Tool) => {
    tool = t;
    paint();
  };
  const setColor = (c: string) => {
    color = c;
    paint();
  };
  const setSize = (s: number) => {
    size = s;
    paint();
  };

  const mod = primaryKey();
  const bar = h(
    "div",
    { class: "ed-bar", role: "toolbar", "aria-label": "Annotate", hidden: "" },
    ...toolButtons,
    h("span", { class: "ed-sep" }),
    ...swatches,
    h("span", { class: "ed-sep" }),
    ...sizeButtons,
    h("span", { class: "ed-sep" }),
    button(icon(ICONS.undo), undo, { class: "ed-btn", "aria-label": `Undo (${mod}+Z)`, title: `Undo (${mod}+Z)` }),
    button(icon(ICONS.clear), clear, { class: "ed-btn", "aria-label": "Clear drawings", title: "Clear drawings" }),
    button(icon(ICONS.reselect), startSelect, { class: "ed-btn", "aria-label": "New selection (N)", title: "New selection (N)" }),
    h("span", { class: "ed-sep" }),
    button(h("span", { class: "ed-act" }, icon(ICONS.copy), "Copy"), () => void copy(), { class: "ed-primary", title: `Copy (${mod}+C)` }),
    button(icon(ICONS.save), () => void save(), { class: "ed-btn", "aria-label": `Save as PNG (${mod}+S)`, title: `Save as PNG (${mod}+S)` }),
    button(icon(ICONS.close), () => ctx.close(), { class: "ed-btn", "aria-label": "Close (Esc)", title: "Close (Esc)" }),
  );
  root.tabIndex = -1; // focusable, so shortcuts work without clicking first
  root.append(stage, bar, toast, empty);
  paint();

  // ---------- pointer ----------

  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (phase === "edit" && e.target !== base && e.target !== ink) return; // the backdrop isn't the picture
    stage.setPointerCapture(e.pointerId);
    const p = toImage(e);
    if (phase === "select") {
      anchor = p;
      area = rectFrom(p, p, base.width, base.height);
      showArea();
      return;
    }
    const width = size * scale() * (tool === "marker" ? MARKER_SCALE : 1);
    drawing = { tool, color, width, points: [p] };
    schedule();
  });
  stage.addEventListener("pointermove", (e) => {
    if (anchor) {
      area = rectFrom(anchor, toImage(e), base.width, base.height);
      showArea();
    } else if (drawing && isShape(drawing.tool)) {
      const from = drawing.points[0];
      if (from) drawing.points.splice(1, Infinity, shapeEnd(from, toImage(e), e.shiftKey));
      schedule();
    } else if (drawing) {
      // Coalesced events keep fast strokes smooth, but the list can be empty: fall back to the event.
      const coalesced = e.getCoalescedEvents?.() ?? [];
      for (const ev of coalesced.length ? coalesced : [e]) drawing.points.push(toImage(ev));
      schedule();
    }
  });
  const end = () => {
    // Releasing the selection opens the editor on it.
    if (phase === "select" && anchor) return void startEdit(chosenArea(area));
    const [a, b] = [drawing?.points[0], drawing?.points[drawing.points.length - 1]];
    const tooSmall = drawing && isShape(drawing.tool) && (!a || !b || Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) < MIN_SHAPE);
    if (drawing && !tooSmall) strokes = [...strokes, drawing];
    drawing = null;
    schedule();
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", () => {
    anchor = null;
    area = null;
    drawing = null;
    showArea();
    schedule();
  });

  // ---------- keys ----------

  // Captured on the document so it runs before the host's Esc-to-close.
  document.addEventListener(
    "keydown",
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const digit = /^Digit([1-8])$/.exec(e.code)?.[1];
      if (phase === "select") {
        if (e.key === "Enter") startEdit(null);
        else if (e.key === "Escape" && anchor) {
          anchor = null;
          area = null;
          showArea();
        } else return;
      } else if (mod && e.code === "KeyC") void copy();
      else if (mod && e.code === "KeyS") void save();
      else if (mod && e.code === "KeyZ") undo();
      else if (!mod && e.code === "KeyP") setTool("pen");
      else if (!mod && e.code === "KeyH") setTool("marker");
      else if (!mod && e.code === "KeyR") setTool("rect");
      else if (!mod && e.code === "KeyO") setTool("ellipse");
      else if (!mod && e.code === "KeyN") startSelect();
      else if (!mod && digit) setColor(CRAYONS[Number(digit) - 1]?.[1] ?? color);
      else return;
      e.preventDefault();
    },
    { capture: true },
  );

  return {
    show() {
      full = null;
      toast.dataset.on = "false";
      ctx.services.capture.latest().then(
        (image) => {
          empty.hidden = !!image;
          stage.hidden = !image;
          if (!image) return;
          full = image;
          startSelect();
        },
        () => (empty.hidden = false),
      );
      root.focus();
    },
  };
}
