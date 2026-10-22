import "./zones.css";
import { h } from "../../sdk/dom";
import { choice, number, toggle } from "../../sdk/options";
import { definePlugin } from "../../sdk/plugin";
import type { Box, Template, ZonesPort } from "./service";

const ICON = `<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="M7 2.75v10.5M7 8h7.25"/>`;

export const TEMPLATES: readonly (readonly [Template, string])[] = [
  ["priorityGrid", "Priority grid"],
  ["columns", "Columns"],
  ["rows", "Rows"],
  ["grid", "Grid"],
  ["focus", "Focus"],
];

const isTemplate = (id: string): id is Template => TEMPLATES.some(([t]) => t === id);

/** How much smaller the preview is than a screen: its gaps shrink as much. */
const PREVIEW_SCALE = 0.16;

/** Draws `zones` (fractions of a screen) into the preview, numbered. */
export function drawPreview(preview: HTMLElement, zones: readonly Box[], spacing: number): void {
  preview.style.setProperty("--half", `${(spacing * PREVIEW_SCALE) / 2}px`);
  const cells = zones.map((z, i) => {
    const cell = h("div", { class: "zn-cell" }, h("div", { class: "zn-zone" }, String(i + 1)));
    Object.assign(cell.style, { left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` });
    return cell;
  });
  preview.replaceChildren(h("div", { class: "zn-screen" }, ...cells));
}

/**
 * Zones, as PowerToys' FancyZones: drag a window with Shift held to snap it into a zone (Ctrl too
 * to span several), pick a zone from the keyboard, or send a window to the next or previous zone,
 * on to the other screens. A tool only: no tab, no glance.
 */
export const zones = definePlugin({
  id: "zones",
  label: "Zones",
  description: "Snap windows into a layout of zones, on every screen.",
  icon: ICON,
  slots: [],
  options: {
    template: choice("Layout", "priorityGrid", TEMPLATES),
    count: number("Zones", 3, { min: 1, max: 9 }),
    spacing: number("Space around zones", 16, { min: 0, max: 64, step: 2, unit: "px" }),
    drag: choice(
      "Show zones while dragging a window",
      "shift",
      [
        ["shift", "While Shift is held"],
        ["always", "Always"],
        ["off", "Never"],
      ],
      "Release the window over a zone to snap it there; hold Ctrl as well to span several. With Always, Shift hides them.",
    ),
    rotate: toggle("Stack the zones on portrait screens", true),
    across: toggle("Next and previous zone go on to the other screens", true),
  },
  commands: [
    {
      id: "pick",
      label: "Snap to a zone",
      description: "Shows the zones: press a zone's number or click it; ← and → for another screen.",
      shortcut: "Ctrl+Alt+Super+KeyZ",
      surface: "action",
    },
    {
      id: "next",
      label: "Move to the next zone",
      description: "The window you're in, to the next zone; after the last, the next screen's first.",
      shortcut: "Ctrl+Alt+Super+ArrowRight",
      surface: "action",
    },
    {
      id: "previous",
      label: "Move to the previous zone",
      description: "The window you're in, to the previous zone.",
      shortcut: "Ctrl+Alt+Super+ArrowLeft",
      surface: "action",
    },
  ],
  // A preview of the layout chosen above, and what the system allows.
  settingsPanel(root, { zones: port }: { zones: ZonesPort }, host) {
    const preview = h("div", { class: "zn-preview", "aria-hidden": "true" });
    const note = h("p", { class: "field-hint zn-note" });
    root.append(preview, note);
    let drawn = "";
    let alive = true;
    const draw = () => {
      const { template, count, spacing } = host.options();
      const key = `${template} ${count} ${spacing}`;
      if (key === drawn || !isTemplate(template)) return;
      drawn = key;
      port.layout(template, count, false).then(
        (zones) => {
          if (alive && key === drawn) drawPreview(preview, zones, spacing);
        },
        () => {},
      );
    };
    draw();
    // The options above are drawn by Settings, which saves a change without redrawing this panel.
    const follow = () => setTimeout(draw);
    document.addEventListener("input", follow);
    document.addEventListener("click", follow);
    port.support().then(
      (s) => {
        note.textContent = s.note ?? "";
        note.hidden = !s.note;
      },
      () => {},
    );
    return () => {
      alive = false;
      document.removeEventListener("input", follow);
      document.removeEventListener("click", follow);
    };
  },
  setup: (_: { zones: ZonesPort }) => ({}),
});
