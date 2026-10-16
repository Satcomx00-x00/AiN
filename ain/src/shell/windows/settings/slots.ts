import { button, h, icon } from "../../../sdk/dom";
import type { AnyPlugin } from "../../../sdk/plugin";

const UP = `<path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7"/>`;
const DOWN = `<path d="M8 3.5v9M4.5 9L8 12.5 11.5 9"/>`;
const X = `<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>`;
const GRIP = `<circle cx="6" cy="4" r=".9" fill="currentColor"/><circle cx="10" cy="4" r=".9" fill="currentColor"/><circle cx="6" cy="8" r=".9" fill="currentColor"/><circle cx="10" cy="8" r=".9" fill="currentColor"/><circle cx="6" cy="12" r=".9" fill="currentColor"/><circle cx="10" cy="12" r=".9" fill="currentColor"/>`;

/** `list` with the item at `from` moved to index `to`. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

export interface SlotListOptions {
  readonly title: string;
  readonly hint?: string;
  readonly ids: readonly string[];
  /** Plugins that may be placed here. */
  readonly candidates: readonly AnyPlugin[];
  readonly onChange: (ids: string[]) => void;
}

/** An ordered, editable list of plugins for one placement: reorder by drag or buttons, remove, add. */
export function slotList({ title, hint, ids, candidates, onChange }: SlotListOptions): HTMLElement {
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const list = h("ol", { class: "slot-list" });
  let dragFrom = -1;

  ids.forEach((id, index) => {
    const plugin = byId.get(id);
    const row = h(
      "li",
      { draggable: "true", "data-unknown": String(!plugin) },
      h("span", { class: "grip", "aria-hidden": "true" }, icon(GRIP)),
      h("span", { class: "slot-icon", "aria-hidden": "true" }, icon(plugin?.icon ?? X)),
      h("span", { class: "slot-name" }, plugin?.label ?? `Unknown "${id}"`),
      h(
        "span",
        { class: "slot-actions" },
        button(icon(UP), () => onChange(move(ids, index, index - 1)), { "aria-label": `Move ${plugin?.label ?? id} up`, ...(index === 0 ? { disabled: "" } : {}) }),
        button(icon(DOWN), () => onChange(move(ids, index, index + 1)), {
          "aria-label": `Move ${plugin?.label ?? id} down`,
          ...(index === ids.length - 1 ? { disabled: "" } : {}),
        }),
        button(icon(X), () => onChange(ids.filter((x) => x !== id)), { "aria-label": `Remove ${plugin?.label ?? id}` }),
      ),
    );
    row.addEventListener("dragstart", (e) => {
      dragFrom = index;
      row.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", id);
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("over");
      if (dragFrom >= 0 && dragFrom !== index) onChange(move(ids, dragFrom, index));
    });
    list.append(row);
  });

  const missing = candidates.filter((p) => !ids.includes(p.id));
  const add = h("select", { class: "slot-add", "aria-label": `Add a widget to ${title}` }, h("option", { value: "" }, missing.length ? "+ Add a widget…" : "Everything is here"));
  for (const p of missing) add.append(h("option", { value: p.id }, p.label));
  add.disabled = missing.length === 0;
  add.addEventListener("change", () => add.value && onChange([...ids, add.value]));

  return h(
    "section",
    { class: "card slot" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", {}, title), ...(hint ? [h("p", {}, hint)] : []))),
    ids.length ? list : h("p", { class: "slot-empty" }, "Nothing here yet."),
    h("div", { class: "slot-foot" }, add),
  );
}
