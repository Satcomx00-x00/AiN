import { h } from "../../sdk/dom";
import type { Box, Overlay, ZonesPort } from "./service";

const DIGIT = /^(?:Digit|Numpad)([1-9])$/;
const EMPTY: Overlay = { zones: [], lit: [], picking: false, screen: 0, screens: 1 };

const same = (a: readonly Box[], b: readonly Box[]) => a.length === b.length && a.every((z, i) => z.x === b[i]?.x && z.y === b[i]?.y && z.w === b[i]?.w && z.h === b[i]?.h);

/** What the picker's hint line says. */
export function hint(o: Overlay): string {
  const count = o.zones.length;
  const pick = count > 1 ? `Press 1–${count} or click a zone` : "Press 1 or click the zone";
  const screens = o.screens > 1 ? ` · ← → screen ${o.screen + 1} of ${o.screens}` : "";
  return `${pick}${screens} · Esc to cancel`;
}

/**
 * The zones overlay. It draws what the backend sends: during a drag, the zones of the screen under
 * the pointer, the one it's over lit up; as the picker, numbered zones to click or type, ←/→ for
 * another screen, Esc (or a click beside them) to cancel. Returns a function that stops it.
 */
export function mountOverlay(root: HTMLElement, port: ZonesPort): () => void {
  let current = EMPTY;
  const layer = h("div", { class: "zo-layer" });
  const line = h("div", { class: "zo-hint", role: "status" });
  root.append(layer, line);

  const zone = (z: Box, i: number) => {
    const el = h("button", { type: "button", class: "zo-zone", "aria-label": `Zone ${i + 1}`, tabindex: "-1" }, h("span", { class: "zo-num" }, String(i + 1)));
    Object.assign(el.style, { left: `${z.x}px`, top: `${z.y}px`, width: `${z.w}px`, height: `${z.h}px` });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (current.picking) void port.snap(i);
    });
    return el;
  };

  const draw = (o: Overlay) => {
    if (!same(o.zones, current.zones) || !layer.children.length) layer.replaceChildren(...o.zones.map(zone));
    [...layer.children].forEach((el, i) => el.setAttribute("data-lit", String(o.lit.includes(i))));
    root.dataset.picking = String(o.picking);
    line.hidden = !o.picking;
    line.textContent = o.picking ? hint(o) : "";
    current = o;
  };

  const keydown = (e: KeyboardEvent) => {
    if (!current.picking) return;
    const digit = DIGIT.exec(e.code)?.[1];
    if (digit && Number(digit) <= current.zones.length) void port.snap(Number(digit) - 1);
    else if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) void port.screen(1);
    else if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) void port.screen(-1);
    else if (e.key === "Escape") void port.cancel(true);
    else return;
    e.preventDefault();
  };
  // A click beside the zones cancels the picker; going to another window too, leaving it there.
  const beside = () => {
    if (current.picking) void port.cancel(true);
  };
  const away = () => {
    if (current.picking) void port.cancel(false);
  };
  root.addEventListener("click", beside);
  window.addEventListener("blur", away);
  document.addEventListener("keydown", keydown);
  const watching = port.watchOverlay(draw).catch(() => () => {});
  return () => {
    root.removeEventListener("click", beside);
    window.removeEventListener("blur", away);
    document.removeEventListener("keydown", keydown);
    void watching.then((stop) => stop());
  };
}
