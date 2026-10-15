import "./select.css";
import { h, icon } from "./dom";

/** One choice in a `select`. */
export interface SelectOption {
  readonly value: string;
  /** Its name, in bold. */
  readonly label: string;
  /** A second line, muted: what it is. */
  readonly detail?: string | undefined;
  /** A short fact on the right, e.g. a size. */
  readonly meta?: string | undefined;
  /** A small tag after the name, e.g. "Downloaded". */
  readonly badge?: string | undefined;
}

export interface Select {
  readonly el: HTMLElement;
  /** Shows `value` as chosen (without calling `onChange`). */
  set(value: string): void;
  /** Replaces the choices, e.g. when their badges change. */
  setOptions(options: readonly SelectOption[]): void;
}

const CHEVRON = `<path d="M4.5 6.5 8 10l3.5-3.5"/>`;
const CHECK = `<path d="M3.5 8.5 6.5 11.5 12.5 5"/>`;
/** The list opens upward when less room than this is left below. */
const ROOM = 280;

let ids = 0;

/**
 * A drop-down list, styled like the rest of the island: a button showing the chosen option, which
 * opens a list of options with a name, a description, a fact on the right and a badge each.
 * Keyboard: arrows, Home/End, Enter or Space to choose, Escape to close.
 */
export function select(options: readonly SelectOption[], value: string, onChange: (value: string) => void, label: string): Select {
  const id = `ui-select-${++ids}`;
  let current = value;
  let items: readonly SelectOption[] = options;
  let active = -1;

  const shown = h("span", { class: "ui-select-value" });
  const trigger = h(
    "button",
    { type: "button", class: "ui-select-trigger", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-controls": `${id}-list`, "aria-label": label },
    shown,
    icon(CHEVRON, "icon ui-select-chevron"),
  );
  const list = h("div", { class: "ui-select-list", role: "listbox", id: `${id}-list`, tabindex: "-1", "aria-label": label });
  list.hidden = true;
  const el = h("div", { class: "ui-select" }, trigger, list);

  const text = (o: SelectOption, cls: string) =>
    h(
      "span",
      { class: cls },
      h("span", { class: "ui-select-label" }, o.label, ...(o.badge ? [h("span", { class: "ui-select-badge" }, o.badge)] : [])),
      ...(o.detail ? [h("span", { class: "ui-select-detail" }, o.detail)] : []),
    );

  const drawValue = () => {
    const o = items.find((i) => i.value === current);
    shown.replaceChildren(...(o ? [text(o, "ui-select-text"), ...(o.meta ? [h("span", { class: "ui-select-meta" }, o.meta)] : [])] : []));
  };

  const rows = () => [...list.children] as HTMLElement[];
  const highlight = (i: number) => {
    active = Math.max(0, Math.min(items.length - 1, i));
    rows().forEach((row, n) => row.classList.toggle("active", n === active));
    const row = rows()[active];
    if (!row) return;
    list.setAttribute("aria-activedescendant", row.id);
    row.scrollIntoView?.({ block: "nearest" });
  };

  const drawList = () => {
    list.replaceChildren(
      ...items.map((o, n) => {
        const row = h(
          "div",
          { class: "ui-select-option", role: "option", id: `${id}-${n}`, "aria-selected": String(o.value === current) },
          icon(CHECK, "icon ui-select-check"),
          text(o, "ui-select-text"),
          ...(o.meta ? [h("span", { class: "ui-select-meta" }, o.meta)] : []),
        );
        row.addEventListener("pointermove", () => active !== n && highlight(n));
        row.addEventListener("click", () => choose(n));
        return row;
      }),
    );
  };

  const isOpen = () => !list.hidden;
  const open = () => {
    if (isOpen() || !items.length) return;
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const room = window.innerHeight - trigger.getBoundingClientRect().bottom;
    el.classList.toggle("up", room < ROOM && trigger.getBoundingClientRect().top > room);
    highlight(Math.max(0, items.findIndex((o) => o.value === current)));
    list.focus();
    document.addEventListener("pointerdown", outside, true);
  };
  const close = (refocus = true) => {
    if (!isOpen()) return;
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    list.removeAttribute("aria-activedescendant");
    document.removeEventListener("pointerdown", outside, true);
    if (refocus) trigger.focus();
  };
  const outside = (e: Event) => {
    if (!el.contains(e.target as Node)) close(false);
  };
  const choose = (n: number) => {
    const o = items[n];
    close();
    if (!o || o.value === current) return;
    set(o.value);
    onChange(o.value);
  };

  trigger.addEventListener("click", () => (isOpen() ? close() : open()));
  trigger.addEventListener("keydown", (e) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener("keydown", (e) => {
    const step: Record<string, () => void> = {
      ArrowDown: () => highlight(active + 1),
      ArrowUp: () => highlight(active - 1),
      Home: () => highlight(0),
      End: () => highlight(items.length - 1),
      Enter: () => choose(active),
      " ": () => choose(active),
      Escape: () => close(),
      Tab: () => close(),
    };
    const run = step[e.key];
    if (!run) return;
    if (e.key !== "Tab") e.preventDefault();
    run();
  });

  const set = (next: string) => {
    current = next;
    drawValue();
    rows().forEach((row, n) => row.setAttribute("aria-selected", String(items[n]?.value === current)));
  };
  const setOptions = (next: readonly SelectOption[]) => {
    items = next;
    drawList();
    drawValue();
    if (isOpen()) highlight(active);
  };

  setOptions(options);
  return { el, set, setOptions };
}
