import "./overlay.css";
import { idlePopup, tauriPopup } from "../core/commands";
import { memorySettings, tauriSettings } from "../core/settings";
import { hostCommands } from "../core/surface";
import { layout } from "../layout";
import { catalogue } from "../plugins";
import { type Services, tauriServices } from "../services";

const inTauri = "__TAURI_INTERNALS__" in window;

/** In the browser preview, a generated picture stands in for a real (private) screen capture. */
function sampleCapture(): ImageData {
  const c = document.createElement("canvas");
  [c.width, c.height] = [Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)];
  const g = c.getContext("2d");
  if (!g) return new ImageData(1, 1);
  const bg = g.createLinearGradient(0, 0, c.width, c.height);
  bg.addColorStop(0, "#3a5a8c");
  bg.addColorStop(1, "#11151f");
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "rgba(255, 255, 255, 0.92)";
  g.fillRect(c.width * 0.18, c.height * 0.3, c.width * 0.5, c.height * 0.42);
  g.fillStyle = "#1c1c1e";
  g.font = `${Math.round(24 * devicePixelRatio)}px system-ui`;
  g.fillText("A window you want to show someone", c.width * 0.21, c.height * 0.4);
  return g.getImageData(0, 0, c.width, c.height);
}

const sample: Services = {
  ...tauriServices,
  screen: { latest: async () => sampleCapture(), save: async (_, name) => `C:\\Users\\you\\Pictures\\Island\\${name}` },
  clipboard: { ...tauriServices.clipboard, copyImage: async () => {} },
};

const container = document.createElement("div");
container.className = "surface";
document.body.append(container);
hostCommands({
  container,
  catalogue,
  layout,
  services: inTauri ? tauriServices : sample,
  popup: inTauri ? tauriPopup : idlePopup,
  store: inTauri ? tauriSettings : memorySettings(),
});

/**
 * Preview only. `?demo`: drag an area, release to edit it, then scribble on it.
 * `?demo=select`: stop mid-drag, to see the selection step.
 */
async function demo(mode: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  const stage = document.querySelector<HTMLElement>(".ed-stage");
  if (!stage) return;
  // Like a real pointer, the event goes to whatever is under it (the picture, or the backdrop).
  const at = ([x, y]: [number, number], type: string) => {
    const [cx, cy] = [innerWidth * x, innerHeight * y];
    (document.elementFromPoint(cx, cy) ?? stage).dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, button: 0, pointerId: 1, bubbles: true }));
  };
  const key = (code: string) => document.dispatchEvent(new KeyboardEvent("keydown", { code, key: code.replace(/^Key|^Digit/, "").toLowerCase() }));
  const draw = (points: [number, number][], release = true) => {
    const [first, ...rest] = points;
    if (!first) return;
    at(first, "pointerdown");
    for (const p of rest) at(p, "pointermove");
    if (release) at(rest[rest.length - 1] ?? first, "pointerup");
  };
  if (mode === "select") return draw([[0.16, 0.26], [0.5, 0.5], [0.71, 0.76]], false);
  draw([[0.16, 0.26], [0.5, 0.5], [0.71, 0.76]]);
  await wait(100);
  const circle = (cx: number, cy: number, r: number): [number, number][] =>
    Array.from({ length: 40 }, (_, i) => [cx + (r * Math.cos((i / 39) * Math.PI * 2)) / 1.6, cy + r * Math.sin((i / 39) * Math.PI * 2)]);
  draw(circle(0.45, 0.4, 0.08));
  key("Digit5");
  draw([[0.68, 0.7], [0.6, 0.6], [0.52, 0.5]]);
  key("KeyR");
  key("Digit4");
  draw([[0.24, 0.6], [0.34, 0.68], [0.4, 0.72]]);
}
const mode = new URLSearchParams(location.search).get("demo");
if (!inTauri && mode !== null) void demo(mode);
