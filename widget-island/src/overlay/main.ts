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

/** Preview only (`?demo`): scribble with simulated pointer input, to see the editor in use. */
async function demo() {
  await new Promise((r) => setTimeout(r, 300));
  const stage = document.querySelector<HTMLElement>(".ed-stage");
  if (!stage) return;
  const press = (key: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key }));
  const draw = (points: [number, number][]) => {
    const at = ([x, y]: [number, number], type: string) =>
      stage.dispatchEvent(new PointerEvent(type, { clientX: innerWidth * x, clientY: innerHeight * y, button: 0, pointerId: 1, bubbles: true }));
    const [first, ...rest] = points;
    if (!first) return;
    at(first, "pointerdown");
    for (const p of rest) at(p, "pointermove");
    at(rest[rest.length - 1] ?? first, "pointerup");
  };
  const circle = (cx: number, cy: number, r: number): [number, number][] =>
    Array.from({ length: 40 }, (_, i) => [cx + (r * Math.cos((i / 39) * Math.PI * 2)) / 1.6, cy + r * Math.sin((i / 39) * Math.PI * 2)]);
  draw(circle(0.43, 0.42, 0.07));
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit5", key: "5" }));
  draw([[0.62, 0.62], [0.55, 0.55], [0.48, 0.47]]);
  press("h");
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit3", key: "3" }));
  draw([[0.21, 0.52], [0.4, 0.52], [0.6, 0.52]]);
  press("r");
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit4", key: "4" }));
  draw([[0.2, 0.6], [0.32, 0.66], [0.38, 0.69]]);
  press("o");
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit6", key: "6" }));
  draw([[0.5, 0.6], [0.58, 0.66], [0.62, 0.69]]);
}
if (!inTauri && new URLSearchParams(location.search).has("demo")) void demo();
