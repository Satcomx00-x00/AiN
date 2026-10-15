import "./settings.css";
import { type Entry, type PopupPort, commandsOf, fromKey, idlePopup, keycaps, shortcutOf, surfaceOf, tauriPopup } from "../../commands";
import { button, h, icon } from "../../../sdk/dom";
import { resolve } from "../../../sdk/options";
import type { Layout } from "../../placement";
import type { AnyPlugin } from "../../../sdk/plugin";
import {
  CURVE_RANGE,
  DELAY_RANGE,
  type General,
  WIDTH_RANGE,
  type Settings,
  type SettingsPort,
  defaults,
  memorySettings,
  parseSettings,
  placeNew,
  setExtension,
  tauriSettings,
} from "../../settings";
import { type Extension, type ExtensionsPort, fileRows, loadExtensions, noExtensions, tauriExtensions } from "../../extensions";
import type { Found } from "../../bindings/extensions";
import { layout as defaultLayout } from "../../../features/layout";
import { catalogue, extensionRules } from "../../../features";
import { THEMES, themeById } from "../../themes";
import { colorPicker, field, optionControl, rangeControl, switchControl, themeGrid } from "./controls";
import { slotList } from "./slots";

const SAVE_DELAY = 250;
/** Built-in features, then plugins from enabled files that loaded fine. */
let plugins: readonly AnyPlugin[] = catalogue;
const fallback = defaults(defaultLayout);
// Outside Tauri (the browser preview) settings live in memory and there are no shortcuts.
const inTauri = "__TAURI_INTERNALS__" in window;
const store: SettingsPort = inTauri ? tauriSettings : memorySettings();
const popup: PopupPort = inTauri ? tauriPopup : idlePopup;
const folder: ExtensionsPort = inTauri ? tauriExtensions : noExtensions;
// Only built-in features offer shortcuts.
const entries = commandsOf(catalogue);
/** Shortcuts the island couldn't register, and why. */
let failures: Record<string, string> = {};

const SECTIONS = {
  appearance: {
    label: "Appearance",
    icon: `<path d="M8 1.75a6.25 6.25 0 1 0 0 12.5c.9 0 1.4-.6 1.4-1.3 0-.9-.8-1.2-.8-2 0-.7.6-1.2 1.3-1.2h1.5a2.85 2.85 0 0 0 2.85-2.85C14.25 4.1 11.45 1.75 8 1.75z"/><circle cx="4.9" cy="7.4" r=".9"/><circle cx="7.2" cy="4.7" r=".9"/><circle cx="10.4" cy="5.2" r=".9"/>`,
  },
  general: { label: "General", icon: `<path d="M3 4.5h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.75"/><circle cx="10.5" cy="11.5" r="1.75"/>` },
  layout: { label: "Layout", icon: `<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M2.5 7h11M7 7v6"/>` },
  shortcuts: { label: "Shortcuts", icon: `<rect x="1.75" y="4" width="12.5" height="8" rx="1.75"/><path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h-.5M5 9.5h6"/>` },
  widgets: { label: "Widgets", icon: `<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>` },
  plugins: {
    label: "Plugins",
    icon: `<path d="M6 2.5v3M10 2.5v3"/><path d="M4 5.5h8v2.75a4 4 0 0 1-8 0z"/><path d="M8 12.25v1.25"/>`,
  },
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
const setGeneral = (patch: Partial<General>, redraw = false) => {
  commit({ ...settings, general: { ...settings.general, ...patch } }, redraw);
  paintAccent();
};
/** The settings window takes the island's accent too. */
const paintAccent = () => document.documentElement.style.setProperty("--accent", settings.general.accentColor);
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

function appearance(): Node[] {
  const theme = themeById(settings.general.theme);
  return [
    ...header("Appearance", "Colors and shape of the island. Choosing a theme below sets every color at once; fine-tune them here. Changes apply right away."),
    h(
      "section",
      { class: "card" },
      field(
        "Pill color",
        "The background of the pill and the open island. Click the swatch for the palette, or type a hex code. On a light color the text turns dark.",
        colorPicker(settings.general.pillColor, theme.bg, (v) => setGeneral({ pillColor: v }), "Pill color"),
      ),
      field(
        "Accent color",
        "Buttons, progress bars and highlights, in the island and in this window.",
        colorPicker(settings.general.accentColor, theme.accent, (v) => setGeneral({ accentColor: v }), "Accent color"),
      ),
    ),
    h(
      "section",
      { class: "card" },
      field(
        "Pill width",
        "How wide the folded pill is. The open island never gets narrower than its panel.",
        rangeControl(settings.general.pillWidth, { ...WIDTH_RANGE, unit: "px" }, (v) => setGeneral({ pillWidth: v }), "Pill width"),
      ),
      field(
        "Corner curve",
        "How round the bottom corners are: 100 % is a full pill, 0 % square corners.",
        rangeControl(settings.general.pillCurve, { ...CURVE_RANGE, unit: "%" }, (v) => setGeneral({ pillCurve: v }), "Corner curve"),
      ),
    ),
    h(
      "section",
      { class: "card" },
      field(
        "Theme",
        `${theme.name}. A theme sets the pill and accent colors, the text, and the status colors (done, warning, recording…).`,
        themeGrid(THEMES, theme.id, (th) => setGeneral({ theme: th.id, pillColor: th.bg, accentColor: th.accent }, true)),
        true,
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

/** The system folder picker; null when cancelled or outside the app. */
async function pickFolder(current: string): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({ directory: true, multiple: false, ...(current ? { defaultPath: current } : {}) });
  return typeof chosen === "string" ? chosen : null;
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
          ? fields.map(([key, f]) => optionControl(f, values[key], (v) => setOption(p.id, key, v), pickFolder))
          : [h("p", { class: "no-options" }, "No options.")]),
      );
    }),
  ];
}

// ---------- plugins from the plugins folder ----------

/** The folder's files (re-read each time the section opens) and the enabled files loaded so far. */
let found: { dir: string; plugins: Found[] } = { dir: "", plugins: [] };
const loaded = new Map<string, Extension>();

/** Loads enabled files not loaded yet (their code only runs once turned on), then refreshes the plugin list. */
async function loadFresh(): Promise<void> {
  const fresh = found.plugins.filter((p) => settings.extensions.includes(p.file) && !loaded.has(p.file));
  if (fresh.length) {
    const taken = new Set([...extensionRules.taken, ...[...loaded.values()].flatMap((e) => (e.plugin ? [e.plugin.id] : []))]);
    for (const ext of await loadExtensions(fresh, { ...extensionRules, taken })) loaded.set(ext.file, ext);
  }
  plugins = [...catalogue, ...[...loaded.values()].flatMap((e) => (e.plugin && settings.extensions.includes(e.file) ? [e.plugin] : []))];
}

// One load at a time, or two would both load a file and the second would find its id taken.
let loading: Promise<void> = Promise.resolve();
const loadEnabled = (): Promise<void> => (loading = loading.then(loadFresh, loadFresh));

async function rescan(): Promise<void> {
  found = await folder.list().catch(() => ({ dir: "", plugins: [] }));
  await loadEnabled();
}

async function toggleFile(file: string, on: boolean): Promise<void> {
  const known = loaded.get(file)?.plugin ?? undefined;
  commit(setExtension(settings, file, on, known), true);
  if (!on) return;
  await loadEnabled();
  const plugin = loaded.get(file)?.plugin;
  // Placed right away, so turning it on shows it.
  commit(plugin ? placeNew(settings, plugin) : settings, true);
}

function pluginsSection(): Node[] {
  const rows = fileRows(found.plugins, settings.extensions, loaded);
  const list = rows.map((row) => {
    const title = row.plugin?.label ?? row.file;
    const detail = row.problem
      ? `Can't be used: ${row.problem}`
      : row.plugin
        ? `${row.plugin.description}${row.needs.length ? ` Uses: ${row.needs.join(", ")}.` : ""}`
        : row.on
          ? "Loading…"
          : "Off. Its code doesn't run until you turn it on.";
    const card = h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "ico", "aria-hidden": "true" }, icon(row.plugin?.icon ?? `<path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M9.5 2.5V5H12"/>`)),
        h("div", { class: "grow" }, h("h2", {}, title), h("p", {}, detail)),
        switchControl(row.on, (on) => void toggleFile(row.file, on).then(render), `Use ${title}`),
      ),
    );
    if (row.problem) card.classList.add("failed");
    return card;
  });
  return [
    ...header("Plugins", "Widgets made by others: JavaScript files in your plugins folder. Turn one on to load it."),
    h(
      "p",
      { class: "note" },
      "A plugin runs inside the island with its permissions, like an app you install: only turn on plugins you trust. After changing a plugin's file, restart Island.",
    ),
    ...(list.length ? list : [h("p", { class: "lead" }, "No plugins yet. Put a .js file (or a folder with an index.js) in the plugins folder.")]),
    h(
      "div",
      { class: "actions" },
      button("Open plugins folder", () => void folder.openDir().then(rescan).then(render).catch(() => {}), { class: "secondary", ...(inTauri ? {} : { disabled: "" }) }),
      button("Refresh", () => void rescan().then(render), { class: "secondary" }),
    ),
    ...(found.dir ? [h("p", { class: "note" }, found.dir)] : []),
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

const RENDER: Record<Section, () => Node[]> = { appearance, general, layout, shortcuts, widgets, plugins: pluginsSection, about };

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
  paintAccent();
  render();
  void loadEnabled().then(render);
});

void rescan().then(render);
