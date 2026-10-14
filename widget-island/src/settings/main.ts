import "./settings.css";
import { type Entry, type PopupPort, commandsOf, fromKey, idlePopup, keycaps, shortcutOf, surfaceOf, tauriPopup } from "../core/commands";
import { button, h, icon } from "../core/dom";
import { resolve } from "../core/options";
import type { Layout } from "../core/placement";
import type { AnyPlugin } from "../core/plugin";
import { DELAY_RANGE, type General, type Settings, type SettingsPort, defaults, memorySettings, parseSettings, tauriSettings } from "../core/settings";
import { layout as defaultLayout } from "../layout";
import { catalogue } from "../plugins";
import { field, optionControl, rangeControl, switchControl } from "./controls";
import { slotList } from "./slots";

const SAVE_DELAY = 250;
const plugins: readonly AnyPlugin[] = catalogue;
const fallback = defaults(defaultLayout);
// Outside Tauri (the browser preview) settings live in memory and there are no shortcuts.
const inTauri = "__TAURI_INTERNALS__" in window;
const store: SettingsPort = inTauri ? tauriSettings : memorySettings();
const popup: PopupPort = inTauri ? tauriPopup : idlePopup;
const entries = commandsOf(plugins);
/** Shortcuts the island couldn't register, and why. */
let failures: Record<string, string> = {};

const SECTIONS = {
  general: { label: "General", icon: `<path d="M3 4.5h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.75"/><circle cx="10.5" cy="11.5" r="1.75"/>` },
  layout: { label: "Layout", icon: `<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M2.5 7h11M7 7v6"/>` },
  shortcuts: { label: "Shortcuts", icon: `<rect x="1.75" y="4" width="12.5" height="8" rx="1.75"/><path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h-.5M5 9.5h6"/>` },
  widgets: { label: "Widgets", icon: `<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>` },
  about: { label: "About", icon: `<circle cx="8" cy="8" r="6"/><path d="M8 7.25v3.5M8 5.25v.01"/>` },
} as const;
type Section = keyof typeof SECTIONS;

let settings: Settings = fallback;
const isSection = (s: string): s is Section => s in SECTIONS;
const fromHash = location.hash.slice(1);
let section: Section = isSection(fromHash) ? fromHash : "general";
let pending: ReturnType<typeof setTimeout> | undefined;

const content = h("main", { class: "content" });
const status = h("div", { class: "status", "data-state": "saved", role: "status" }, "Saved");
const nav = h("nav", { class: "nav", "aria-label": "Settings sections" });

// ---------- state ----------

const setStatus = (state: "saved" | "saving" | "error", text: string) => {
  status.dataset.state = state;
  status.textContent = text;
};

/** Updates settings; saves shortly after the last change. `redraw` rebuilds the section (for structural edits). */
function commit(next: Settings, redraw = false) {
  settings = next;
  if (redraw) render();
  setStatus("saving", "Saving…");
  clearTimeout(pending);
  pending = setTimeout(() => {
    pending = undefined;
    store.save(settings).then(
      () => setStatus("saved", "Saved"),
      (e: unknown) => setStatus("error", `Not saved: ${String(e)}`),
    );
  }, SAVE_DELAY);
}

const setLayout = (layout: Layout) => commit({ ...settings, layout }, true);
const setGeneral = (patch: Partial<General>) => commit({ ...settings, general: { ...settings.general, ...patch } });
const setShortcut = (id: string, value: string | null) => commit({ ...settings, shortcuts: { ...settings.shortcuts, [id]: value } }, true);
const resetShortcut = (id: string) => {
  const { [id]: _, ...rest } = settings.shortcuts;
  commit({ ...settings, shortcuts: rest }, true);
};
const setOption = (id: string, key: string, value: unknown) =>
  commit({ ...settings, options: { ...settings.options, [id]: { ...settings.options[id], [key]: value } } });

// ---------- sections ----------

function header(title: string, lead: string) {
  return [h("h1", {}, title), h("p", { class: "lead" }, lead)];
}

function general(): Node[] {
  const autostart = switchControl(false, (on) => {
    store.setAutostart(on).catch((e: unknown) => {
      autostart.setAttribute("aria-checked", String(!on));
      setStatus("error", `Launch at login: ${String(e)}`);
    });
  }, "Launch at login");
  store.autostart().then((on) => autostart.setAttribute("aria-checked", String(on)), () => (autostart.disabled = true));
  return [
    ...header("General", "How the island behaves. Changes apply right away."),
    h(
      "section",
      { class: "card" },
      field("Launch at login", "Start the island when you sign in.", autostart),
      field(
        "Open after hovering",
        "How long the pointer rests on the pill before it opens. Higher avoids accidental opens near the top of the screen.",
        rangeControl(settings.general.openDelay, { ...DELAY_RANGE, unit: "ms" }, (v) => setGeneral({ openDelay: v }), "Open delay"),
      ),
      field(
        "Close after leaving",
        "Grace time before it folds back once the pointer leaves.",
        rangeControl(settings.general.closeDelay, { ...DELAY_RANGE, unit: "ms" }, (v) => setGeneral({ closeDelay: v }), "Close delay"),
      ),
    ),
  ];
}

function layout(): Node[] {
  const { glance, tabs } = settings.layout;
  const glanceable = plugins.filter((p) => p.slots.includes("glance"));
  return [
    ...header("Layout", "Choose what shows where. Drag to reorder, or use the arrows."),
    h(
      "div",
      { class: "slots" },
      slotList({
        title: "Left of the pill",
        hint: "The first widget with something to show wins.",
        ids: glance.left,
        candidates: glanceable,
        onChange: (left) => setLayout({ ...settings.layout, glance: { ...glance, left } }),
      }),
      slotList({
        title: "Right of the pill",
        hint: "In priority order: the first with something to show wins.",
        ids: glance.right,
        candidates: glanceable,
        onChange: (right) => setLayout({ ...settings.layout, glance: { ...glance, right } }),
      }),
      slotList({
        title: "Tabs",
        hint: "Shown when the island opens, in this order.",
        ids: tabs,
        candidates: plugins.filter((p) => p.slots.includes("tab")),
        onChange: (next) => setLayout({ ...settings.layout, tabs: next }),
      }),
    ),
    h("div", { class: "actions" }, button("Restore default layout", () => setLayout(defaultLayout), { class: "secondary" })),
  ];
}

/** A shortcut recorder: shows the keys; click, then press the new combination. */
function recorder(entry: Entry): HTMLElement {
  const current = shortcutOf(entry, settings.shortcuts);
  const keys = h("span", { class: "keys" }, ...(current ? keycaps(current).map((k) => h("kbd", {}, k)) : [h("span", { class: "off" }, "Off")]));
  const change = button("Change", () => {
    change.textContent = "Press keys…";
    change.classList.add("recording");
    keys.replaceChildren(h("span", { class: "off" }, "Esc to cancel, Backspace to turn off"));
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        stop();
        render();
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        stop();
        setShortcut(entry.id, null);
        return;
      }
      const shortcut = fromKey(e);
      if (!shortcut) return; // only modifiers so far
      stop();
      setShortcut(entry.id, shortcut);
    };
    const stop = () => window.removeEventListener("keydown", onKey, true);
    window.addEventListener("keydown", onKey, true);
  }, { class: "secondary" });
  const isDefault = !(entry.id in settings.shortcuts);
  return h(
    "div",
    { class: "recorder" },
    keys,
    change,
    ...(isDefault ? [] : [button("Reset", () => resetShortcut(entry.id), { class: "secondary" })]),
    button("Try it", () => popup.open(entry.id, surfaceOf(entry)).catch(() => {}), { class: "secondary", ...(inTauri ? {} : { disabled: "" }) }),
  );
}

function shortcuts(): Node[] {
  return [
    ...header("Shortcuts", "The island is also a multi-tool: these work anywhere, even when the island is folded."),
    entries.length
      ? h(
          "section",
          { class: "card" },
          ...entries.map((e) => {
            const failed = failures[e.id];
            const hint = failed ? `${e.command.description} — ${failed}: pick another shortcut.` : e.command.description;
            const row = field(`${e.command.label} · ${e.plugin.label}`, hint, recorder(e));
            if (failed) row.classList.add("failed");
            return row;
          }),
        )
      : h("p", { class: "lead" }, "No widget offers shortcuts yet."),
    h("p", { class: "note" }, "Shortcuts using Win with a single letter (like Win+B or Win+V) are reserved by Windows; add Shift or Alt."),
  ];
}

/** Where the layout currently shows a plugin. */
function placesOf(id: string): string[] {
  const { glance, tabs } = settings.layout;
  const places: [boolean, string][] = [
    [glance.left.includes(id), "Left"],
    [glance.right.includes(id), "Right"],
    [tabs.includes(id), "Tabs"],
  ];
  return places.filter(([on]) => on).map(([, name]) => name);
}

function widgets(): Node[] {
  return [
    ...header("Widgets", "Each widget's own options."),
    ...plugins.map((p) => {
      const fields = Object.entries(p.options ?? {});
      const values = resolve(p.options ?? {}, settings.options[p.id]) as Record<string, unknown>;
      return h(
        "section",
        { class: "card" },
        h(
          "div",
          { class: "card-head" },
          h("span", { class: "ico", "aria-hidden": "true" }, icon(p.icon)),
          h("div", { class: "grow" }, h("h2", {}, p.label), h("p", {}, p.description)),
          h(
            "span",
            { class: "badge", "data-placed": String(placesOf(p.id).length > 0) },
            placesOf(p.id).join(" · ") || "Not placed — add it in Layout",
          ),
        ),
        ...(fields.length
          ? fields.map(([key, f]) => optionControl(f, values[key], (v) => setOption(p.id, key, v)))
          : [h("p", { class: "no-options" }, "No options.")]),
      );
    }),
  ];
}

function about(): Node[] {
  let armed = false;
  const reset = button("Reset all settings", () => {
    if (!armed) {
      armed = true;
      reset.textContent = "Click again to reset everything";
      reset.classList.add("danger");
      return;
    }
    commit(fallback, true);
  }, { class: "secondary" });
  return [
    ...header("About", "Island — a Dynamic Island for your desktop."),
    h(
      "section",
      { class: "card" },
      field("Saving", "Settings save automatically and apply to the island instantly.", h("span", {})),
      field("Open this window", "Right-click the pill, or use the tray icon.", h("span", {})),
      field("Reset", "Restores the default layout, delays and every widget option.", reset),
    ),
  ];
}

const RENDER: Record<Section, () => Node[]> = { general, layout, shortcuts, widgets, about };

function render() {
  for (const b of nav.querySelectorAll<HTMLButtonElement>("button[data-section]")) {
    if (b.dataset.section === section) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  const scroll = content.scrollTop;
  content.replaceChildren(...RENDER[section]());
  content.scrollTop = scroll;
}

// ---------- bootstrap ----------

nav.append(
  h("div", { class: "brand" }, h("span", { class: "brand-pill", "aria-hidden": "true" }), "Island"),
  ...(Object.keys(SECTIONS) as Section[]).map((key) =>
    button(h("span", { class: "nav-in" }, icon(SECTIONS[key].icon), SECTIONS[key].label), () => {
      section = key;
      history.replaceState(null, "", `#${key}`);
      content.scrollTop = 0;
      render();
    }, { "data-section": key }),
  ),
  status,
);
document.body.append(h("div", { class: "app" }, nav, content));

void popup.watchFailures((next) => {
  failures = next;
  if (section === "shortcuts") render();
});

void store.watch((raw) => {
  // Ignore our own saves echoing back while edits are still pending.
  if (pending) return;
  const next = parseSettings(raw, fallback);
  if (JSON.stringify(next) === JSON.stringify(settings) && content.childElementCount) return;
  settings = next;
  render();
});
