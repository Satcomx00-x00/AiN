import { button, h, icon } from "../../../sdk/dom";
import { glanceSlot } from "../../../sdk/glance";
import type { Field } from "../../../sdk/options";
import type { AnyPlugin, Glance } from "../../../sdk/plugin";
import type { Layout } from "../../placement";
import { PER_SIDE_RANGE, type PillLook, WIDTH_RANGE } from "../../settings";
import { MAX_TABS } from "../../tabs";
import { field, rangeControl, segmented, standardFields, switchControl } from "./controls";
import { move } from "./slots";

/** A place on the island: an end of the folded pill, or the tabs of the open one. */
export type Zone = "left" | "right" | "tabs";
type Side = Exclude<Zone, "tabs">;

const ZONE_NAMES: Record<Zone, string> = { left: "Left", right: "Right", tabs: "Tabs" };
const GRIP = `<circle cx="6" cy="4" r=".9" fill="currentColor"/><circle cx="10" cy="4" r=".9" fill="currentColor"/><circle cx="6" cy="8" r=".9" fill="currentColor"/><circle cx="10" cy="8" r=".9" fill="currentColor"/><circle cx="6" cy="12" r=".9" fill="currentColor"/><circle cx="10" cy="12" r=".9" fill="currentColor"/>`;
const LEFT = `<path d="M12.5 8h-9M7 4.5 3.5 8 7 11.5"/>`;
const RIGHT = `<path d="M3.5 8h9M9 4.5 12.5 8 9 11.5"/>`;

const listOf = (layout: Layout, zone: Zone): readonly string[] => (zone === "tabs" ? layout.tabs : layout.glance[zone]);

/** `layout` with `zone`'s list replaced. */
const withList = (layout: Layout, zone: Zone, ids: readonly string[]): Layout =>
  zone === "tabs" ? { ...layout, tabs: ids } : { ...layout, glance: { ...layout.glance, [zone]: ids } };

/** Where a plugin is placed, in Left, Right, Tabs order. */
export const zonesOf = (layout: Layout, id: string): Zone[] => (["left", "right", "tabs"] as const).filter((z) => listOf(layout, z).includes(id));

/** The end of the pill a plugin is on, if any: a plugin is on one end at most. */
export const sideOf = (layout: Layout, id: string): Side | null => (layout.glance.left.includes(id) ? "left" : layout.glance.right.includes(id) ? "right" : null);

/** `layout` without `id` in `zones`. */
export const removed = (layout: Layout, id: string, zones: readonly Zone[]): Layout =>
  zones.reduce((l, z) => withList(l, z, listOf(l, z).filter((x) => x !== id)), layout);

/**
 * Puts `id` in `to` at `index`. Dragged from another zone it moves there; from the widget list
 * (`from` null) it's added. Either way it leaves the other end, since a plugin is on one end at most.
 */
export function placed(layout: Layout, id: string, from: Zone | null, to: Zone, index: number): Layout {
  const leaving: Zone[] = to === "tabs" ? (from && from !== "tabs" ? [from, "tabs"] : ["tabs"]) : from === "tabs" ? ["left", "right", "tabs"] : ["left", "right"];
  const without = removed(layout, id, leaving);
  const list = [...listOf(without, to)];
  list.splice(Math.max(0, Math.min(index, list.length)), 0, id);
  return withList(without, to, list);
}

/** `ids` with `id` in or out, keeping the order of the rest. */
export const toggled = (ids: readonly string[], id: string, on: boolean): string[] => (on ? [...new Set([...ids, id])] : ids.filter((x) => x !== id));

/** What a plugin shows on the preview pill, dressed as the user chose. */
export function previewGlance(p: AnyPlugin, values: Readonly<Record<string, unknown>>, look: PillLook): Glance {
  const said = p.sample?.(values as never) ?? { text: p.label };
  return look.icons.includes(p.id) ? { ...said, icon: p.icon } : said;
}

export interface PillEditor {
  readonly plugins: readonly AnyPlugin[];
  readonly layout: Layout;
  readonly look: PillLook;
  /** The folded pill's width at the Normal size, in px. */
  readonly width: number;
  /** The plugin whose settings show beside the preview. */
  readonly selected: string | null;
  /** A plugin's current option values. */
  values(p: AnyPlugin): Readonly<Record<string, unknown>>;
  /** The control for one of a plugin's options, as on its Widgets page. */
  optionControl(p: AnyPlugin, key: string, f: Field): HTMLElement;
  select(id: string | null): void;
  setLayout(layout: Layout): void;
  setLook(look: PillLook): void;
  /** Saves the width without redrawing, so the slider keeps the pointer. */
  setWidth(px: number): void;
  openWidget(id: string): void;
}

/** One draggable thing: a glance on the pill, a tab, or a row of the widget list. */
const draggable = (el: HTMLElement, id: string, from: Zone | null): HTMLElement => {
  el.dataset.drag = id;
  el.dataset.from = from ?? "";
  return el;
};

/** Settings → Pill: a live preview to drag widgets onto, the widget list, and the selected widget's settings. */
export function pillEditor(ed: PillEditor): Node[] {
  const byId = new Map(ed.plugins.map((p) => [p.id, p]));
  const { layout, look } = ed;

  // ---------- the preview ----------
  /** A widget on the preview pill, drawn as on the island. */
  const chip = (id: string, zone: Side): HTMLElement | null => {
    const p = byId.get(id);
    if (!p) return null;
    const slot = glanceSlot();
    slot.draw(previewGlance(p, ed.values(p), look), id);
    const el = h("span", { class: "pp-item", title: p.label }, slot.el);
    el.classList.toggle("selected", ed.selected === id);
    return draggable(el, id, zone);
  };
  const end = (zone: Side) =>
    h("span", { class: "pp-end", "data-zone": zone, "data-empty": ZONE_NAMES[zone] }, ...layout.glance[zone].slice(0, look.perSide).flatMap((id) => chip(id, zone) ?? []));
  const preview = h(
    "div",
    { class: "pp", style: `--pill-w: ${ed.width}px` },
    h("div", { class: "pp-pill" }, end("left"), h("span", { class: "pp-notch", "aria-hidden": "true" }), end("right")),
  );
  const stage = h(
    "section",
    { class: "pill-stage" },
    preview,
    h(
      "div",
      { class: "pill-bar" },
      field(
        "Width",
        undefined,
        rangeControl(ed.width, { ...WIDTH_RANGE, unit: "px" }, (v) => {
          preview.style.setProperty("--pill-w", `${v}px`);
          ed.setWidth(v);
        }, "Pill width"),
      ),
      field(
        "Per side",
        "How many each side shows at once; the rest wait their turn.",
        segmented(String(look.perSide), Array.from({ length: PER_SIDE_RANGE.max }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })), (v) => ed.setLook({ ...look, perSide: Number(v) }), "Widgets per side"),
      ),
    ),
  );

  // ---------- each side, as an ordered list ----------
  /** One widget of a side's list: its place in the order, what it is, and whether the pill shows it now. */
  const sideRow = (id: string, zone: Side, at: number): HTMLElement | null => {
    const p = byId.get(id);
    if (!p) return null;
    const row = h(
      "div",
      { class: "side-row", title: p.label, "data-waiting": String(at >= look.perSide) },
      h("span", { class: "grip", "aria-hidden": "true" }, icon(GRIP)),
      h("span", { class: "side-n" }, String(at + 1)),
      h("span", { class: "ico", "aria-hidden": "true" }, icon(p.icon)),
      h("span", { class: "side-name" }, p.label),
    );
    row.classList.toggle("selected", ed.selected === id);
    return draggable(row, id, zone);
  };
  const sideCard = (zone: Side) => {
    const rows = layout.glance[zone].filter((id) => byId.has(id)).flatMap((id, i) => sideRow(id, zone, i) ?? []);
    // Where the pill's share ends: the rest show only when one before them has nothing to show.
    if (rows.length > look.perSide) rows.splice(look.perSide, 0, h("div", { class: "side-split" }, "Waiting their turn"));
    return h(
      "section",
      { class: "card side-card", "data-side": zone },
      h("div", { class: "card-head" }, h("h2", {}, `${ZONE_NAMES[zone]} side`), h("span", { class: "card-hint" }, `${Math.min(look.perSide, layout.glance[zone].length)} on the pill`)),
      h("div", { class: "side-list", "data-zone": zone, "data-axis": "y", "data-empty": "Drag a widget here" }, ...rows),
    );
  };
  const sides = h(
    "div",
    { class: "pill-sides" },
    h("p", { class: "pill-help" }, "Each side of the pill shows the first widgets of its list. Further down, they wait: one shows when a widget before it has nothing to show."),
    h("div", { class: "pill-sides-grid" }, sideCard("left"), sideCard("right")),
  );

  // ---------- the tabs ----------
  const tabs = h(
    "div",
    { class: "pp-tabs", "data-zone": "tabs", "data-empty": "Drag a widget here" },
    ...layout.tabs
      .filter((id) => byId.has(id))
      .flatMap((id, i) => {
        const p = byId.get(id)!;
        // Past the bar's limit, behind the island's More tab: marked where it starts, and dimmed.
        const spare = i >= MAX_TABS;
        const el = h("span", { class: "pp-tab", title: spare ? `${p.label} (under More)` : p.label, ...(spare ? { "data-spare": "true" } : {}) }, icon(p.icon));
        el.classList.toggle("selected", ed.selected === id);
        const tab = draggable(el, id, "tabs");
        return i === MAX_TABS ? [h("span", { class: "pp-more", title: "More: the rest are listed under this tab" }, "⋯"), tab] : [tab];
      }),
  );
  const tabsCard = h(
    "section",
    { class: "card tabs-card" },
    h("div", { class: "card-head" }, h("h2", {}, "Tabs"), h("span", { class: "card-hint" }, `When the island opens. The bar holds ${MAX_TABS}; the rest go under ⋯ More.`)),
    tabs,
  );

  // ---------- the widget list ----------
  const placesText = (id: string) => zonesOf(layout, id).map((z) => ZONE_NAMES[z]).join(" · ") || "Off";
  const shelf = h(
    "div",
    { class: "pill-shelf", "data-zone": "shelf" },
    ...ed.plugins
      .filter((p) => p.slots.length)
      .map((p) => {
        const row = button(
          h(
            "span",
            { class: "list-in" },
            h("span", { class: "grip", "aria-hidden": "true" }, icon(GRIP)),
            h("span", { class: "ico", "aria-hidden": "true" }, icon(p.icon)),
            h("span", { class: "grow" }, h("span", { class: "list-title" }, p.label), h("span", { class: "list-detail" }, placesText(p.id))),
          ),
          () => ed.select(p.id),
          { class: "pill-widget", "aria-pressed": String(ed.selected === p.id) },
        );
        return draggable(row, p.id, null);
      }),
  );
  const shelfCard = h(
    "section",
    { class: "card pill-shelf-card" },
    h("div", { class: "card-head" }, h("h2", {}, "Widgets")),
    h("div", { class: "pill-remove", "data-zone": "shelf" }, "Drop here to remove"),
    shelf,
  );

  // ---------- the selected widget ----------
  const inspector = h("section", { class: "card pill-inspector" }, ...inspect(ed, byId.get(ed.selected ?? "")));

  const root = h("div", { class: "pill-editor" }, stage, sides, tabsCard, h("div", { class: "pill-work" }, shelfCard, inspector));
  dragging(root, ed);
  return [root];
}

/** The selected widget's settings: where it goes, how it looks there, and its options. */
function inspect(ed: PillEditor, p: AnyPlugin | undefined): Node[] {
  if (!p) return [h("p", { class: "no-options" }, "Select a widget.")];
  const { layout, look } = ed;
  const side = sideOf(layout, p.id);
  const glances = p.slots.includes("glance");
  const rows: Node[] = [];
  if (glances)
    rows.push(
      field(
        "Side",
        undefined,
        segmented(side ?? "off", [{ value: "off", label: "Off" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }], (v) =>
          ed.setLayout(v === "off" ? removed(layout, p.id, ["left", "right"]) : placed(layout, p.id, side, v as Side, layout.glance[v as Side].length)),
          "Side of the pill",
        ),
      ),
    );
  if (side) {
    const list = layout.glance[side];
    const at = list.indexOf(p.id);
    const shift = (by: number) => ed.setLayout({ ...layout, glance: { ...layout.glance, [side]: move(list, at, at + by) } });
    rows.push(
      field(
        "Position",
        at >= look.perSide ? "Waits for the ones before it." : undefined,
        h(
          "span",
          { class: "pill-order" },
          button(icon(LEFT), () => shift(-1), { class: "secondary pill-step", "aria-label": "Move left", ...(at === 0 ? { disabled: "" } : {}) }),
          button(icon(RIGHT), () => shift(1), { class: "secondary pill-step", "aria-label": "Move right", ...(at === list.length - 1 ? { disabled: "" } : {}) }),
        ),
      ),
      field("Icon", undefined, switchControl(look.icons.includes(p.id), (on) => ed.setLook({ ...look, icons: toggled(look.icons, p.id, on) }), "Icon")),
      field("When idle", "Keeps its icon on the pill, dimmed.", switchControl(look.idle.includes(p.id), (on) => ed.setLook({ ...look, idle: toggled(look.idle, p.id, on) }), "When idle")),
    );
  }
  if (p.slots.includes("tab")) {
    const inTabs = layout.tabs.includes(p.id);
    rows.push(field("In the tabs", undefined, switchControl(inTabs, (on) => ed.setLayout(on ? placed(layout, p.id, null, "tabs", layout.tabs.length) : removed(layout, p.id, ["tabs"])), "In the tabs")));
  }
  const options = standardFields(p.options ?? {}).filter(([, f]) => f.kind !== "secret" && (!f.pill || side));
  return [
    h("div", { class: "card-head" }, h("span", { class: "ico", "aria-hidden": "true" }, icon(p.icon)), h("h2", {}, p.label)),
    ...rows,
    ...options.map(([key, f]) => ed.optionControl(p, key, f)),
    h("div", { class: "card-foot" }, h("span"), button("All options", () => ed.openWidget(p.id), { class: "link" })),
  ];
}

/** How near the top or bottom of the page a drag scrolls it, and how fast at the very edge (px a frame). */
const EDGE = 48;
const SPEED = 14;

/** The nearest ancestor that scrolls up and down, else the document. */
export function scrollerOf(el: Element): Element {
  for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  return document.documentElement;
}

/** How far to scroll a frame with the pointer at `y`: toward the edge it's near, faster nearer it. */
export function edgeSpeed(y: number, top: number, bottom: number): number {
  const into = y < top + EDGE ? y - top - EDGE : y > bottom - EDGE ? y - bottom + EDGE : 0;
  return Math.round((Math.max(-EDGE, Math.min(EDGE, into)) / EDGE) * SPEED);
}

/** Drag and drop with the pointer (mouse, pen or touch); a press without moving selects. A drag near the page's top or bottom scrolls it, so the list reaches the pill in a short window. */
function dragging(root: HTMLElement, ed: PillEditor): void {
  const caret = h("span", { class: "pp-caret", "aria-hidden": "true" });
  root.addEventListener("pointerdown", (down) => {
    const item = (down.target as Element).closest<HTMLElement>("[data-drag]");
    if (!item || down.button !== 0) return;
    const id = String(item.dataset.drag);
    const from = (item.dataset.from || null) as Zone | null;
    let ghost: HTMLElement | null = null;
    /** Where it would land: in `zone`, before or after a neighbour, or at the zone's start. */
    let target: { zone: HTMLElement; before?: string; after?: string } | null = null;
    const page = scrollerOf(root);
    let at = { x: down.clientX, y: down.clientY };
    let frame = 0;

    const over = (x: number, y: number) => {
      caret.remove();
      root.querySelectorAll(".over").forEach((z) => z.classList.remove("over"));
      const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-zone]") ?? null;
      if (!zone || !root.contains(zone)) return null;
      zone.classList.add("over");
      if (zone.dataset.zone === "shelf") return { zone };
      const items = [...zone.querySelectorAll<HTMLElement>(":scope > [data-drag]")].filter((el) => el.dataset.drag !== id);
      // A side's list runs down the page; the pill and the tabs run across.
      const down = zone.dataset.axis === "y";
      const at = items.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return down ? y < r.top + r.height / 2 : x < r.left + r.width / 2;
      });
      if (at === -1) zone.append(caret);
      else items[at]!.before(caret);
      return at === -1 ? { zone, ...(items.length ? { after: items.at(-1)!.dataset.drag! } : {}) } : { zone, before: items[at]!.dataset.drag! };
    };
    const onMove = (e: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 5) return;
        ghost = item.cloneNode(true) as HTMLElement;
        ghost.classList.add("pp-ghost");
        document.body.append(ghost);
        item.classList.add("lifted");
        root.classList.add("dragging");
        root.dataset.from = from ?? "shelf";
      }
      at = { x: e.clientX, y: e.clientY };
      ghost.style.translate = `${at.x}px ${at.y}px`;
      target = over(at.x, at.y);
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const scroll = () => {
      const r = page.getBoundingClientRect();
      const by = edgeSpeed(at.y, Math.max(r.top, 0), Math.min(r.bottom, innerHeight));
      if (!by) {
        frame = 0;
        return;
      }
      page.scrollBy(0, by);
      target = over(at.x, at.y);
      frame = requestAnimationFrame(scroll);
    };
    const end = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      cancelAnimationFrame(frame);
      caret.remove();
      // A press without a drag: a widget-list row selects on its click, which the keyboard gives too.
      if (!ghost) return item.matches("button") ? undefined : ed.select(id);
      ghost.remove();
      item.classList.remove("lifted");
      root.classList.remove("dragging");
      root.querySelectorAll(".over").forEach((z) => z.classList.remove("over"));
      if (!commit || !target) return;
      const to = target.zone.dataset.zone as Zone | "shelf";
      if (to === "shelf") {
        if (from) ed.setLayout(removed(ed.layout, id, [from]));
        return;
      }
      const p = ed.plugins.find((x) => x.id === id);
      if (!p?.slots.includes(to === "tabs" ? "tab" : "glance")) return;
      ed.select(id);
      // By neighbour rather than by count: the list may hold ids the preview doesn't draw.
      const list = listOf(ed.layout, to).filter((x) => x !== id);
      const index = target.before ? list.indexOf(target.before) : target.after ? list.indexOf(target.after) + 1 : 0;
      ed.setLayout(placed(ed.layout, id, from, to, index));
    };
    const up = () => end(true);
    const cancel = () => end(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  });
}
