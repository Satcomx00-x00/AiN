import "./settings.css";
import { type Entry, commandsOf, fromKey, keycaps, shortcutOf, surfaceOf } from "../../commands";
import { button, h, icon } from "../../../sdk/dom";
import { resolve } from "../../../sdk/options";
import type { Layout } from "../../placement";
import type { AnyPlugin } from "../../../sdk/plugin";
import {
  CURVE_RANGE,
  DELAY_RANGE,
  type General,
  REVEAL_RANGE,
  WIDTH_RANGE,
  type Settings,
  defaults,
  parseSettings,
  parseTarget,
  placeNew,
  setExtension,
} from "../../settings";
import { type Extension, fileRows, idOf, loadExtensions } from "../../extensions";
import type { Found } from "../../bindings/extensions";
import { type Offer, noCommunity, offerState } from "../../community";
import { layout as defaultLayout } from "../../../features/layout";
import { catalogue, extensionRules } from "../../../features";
import { greetings } from "../../../features/greetings";
import { styles } from "../../../features/styles";
import type { AnyStyle, PillSize } from "../../../sdk/style";
import { styleById } from "../../styles";
import { NO_GREETING } from "../../greet";
import { type SelectOption, select } from "../../../sdk/select";
import { tauriServices } from "../../../features/services";
import { THEMES, themeById } from "../../themes";
import { aroundPanel, colorPicker, field, optionControl, rangeControl, segmented, standardFields, switchControl, themeGrid } from "./controls";
import type { Field } from "../../../sdk/options";
import { settingsPorts } from "./ports";
import { slotList } from "./slots";
import { type Report, type Tone, demoUpdater, describe, noteLines } from "../../updater";

const SAVE_DELAY = 250;
/** Built-in features, then plugins from enabled files that loaded fine. */
let plugins: readonly AnyPlugin[] = catalogue;
const fallback = defaults(defaultLayout);
// The app's backend, or in-memory stand-ins outside Tauri (the browser preview, integration tests).
const { store, popup, folder, importer, community = noCommunity, updater = demoUpdater(), inApp: inTauri } = settingsPorts();
/** The updater's last report, kept current by its events; null until the first one arrives. */
let update: Report | null = null;
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
// Opened at a place ("widgets:dictation"): the section, then the card to bring into view.
const opened = parseTarget(location.hash.slice(1), Object.keys(SECTIONS));
let section: Section = opened && isSection(opened.section) ? opened.section : "general";
let scrollToCard: string | null = opened?.card ?? null;
/** Stop functions of the plugins' settings panels on screen, called before they're redrawn. */
let panelStops: (() => void)[] = [];
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

function header(title: string, lead?: string) {
  return [h("h1", {}, title), ...(lead ? [h("p", { class: "lead" }, lead)] : [])];
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
    ...header("General"),
    h(
      "section",
      { class: "card" },
      field("Launch at login", undefined, autostart),
      field(
        "Quit AiN",
        undefined,
        button("Quit", () => void store.quit().catch((e: unknown) => setStatus("error", `Couldn't quit: ${String(e)}`)), { class: "secondary danger" }),
      ),
      field(
        "Open delay",
        undefined,
        rangeControl(settings.general.openDelay, { ...DELAY_RANGE, unit: "ms" }, (v) => setGeneral({ openDelay: v }), "Open delay"),
      ),
      field(
        "Close delay",
        undefined,
        rangeControl(settings.general.closeDelay, { ...DELAY_RANGE, unit: "ms" }, (v) => setGeneral({ closeDelay: v }), "Close delay"),
      ),
    ),
    h(
      "section",
      { class: "card" },
      field(
        "Hide the pill",
        "Pick the Hidden style in Appearance: the pill then shows only while the cursor rests at the top center of the screen.",
        button("Appearance", () => goTo("appearance"), { class: "secondary" }),
      ),
    ),
  ];
}

const PILL_SIZES: readonly { value: PillSize; label: string }[] = [
  { value: "low", label: "Low profile" },
  { value: "normal", label: "Normal" },
  { value: "large", label: "Large" },
];

/** The pill's style and size, the reveal delay of a hidden style, and the style's own options. */
function pillCard(): HTMLElement {
  const choices = styleChoices();
  const style = styleById(choices.styles, settings.general.style);
  const values = resolve(style.options ?? {}, settings.options[style.id]) as Record<string, unknown>;
  return h(
    "section",
    { class: "card" },
    field(
      "Pill style",
      style.hidden ? "It shows only while the cursor rests at the top center of the screen, so it stays out of games and other apps." : undefined,
      select(choices.options, style.id, (id) => setGeneral({ style: id }, true), "Pill style").el,
      true,
    ),
    field(
      "Size",
      "A hardware notch keeps its own size.",
      segmented(settings.general.pillSize, PILL_SIZES, (v) => setGeneral({ pillSize: v as PillSize }), "Pill size"),
    ),
    ...(style.hidden
      ? [
          field(
            "Show after",
            "How long the cursor must rest there.",
            rangeControl(settings.general.revealDelay, { ...REVEAL_RANGE, unit: "ms" }, (v) => setGeneral({ revealDelay: v }), "Show after"),
          ),
        ]
      : []),
    ...standardFields(style.options ?? {}).map(([key, f]) => optionControl(f, values[key], (v) => setOption(style.id, key, v), pickFolder)),
  );
}

function appearance(): Node[] {
  const theme = themeById(settings.general.theme);
  const choices = greetingChoices();
  // A choice whose plugin is gone plays the default.
  const chosen = choices.some((c) => c.value === settings.general.greeting) ? settings.general.greeting : greetings[0]!.id;
  return [
    ...header("Appearance"),
    pillCard(),
    h(
      "section",
      { class: "card" },
      field("Startup animation", undefined, greetingPicker(choices, chosen)),
    ),
    h(
      "section",
      { class: "card" },
      field(
        "Pill color",
        undefined,
        colorPicker(settings.general.pillColor, theme.bg, (v) => setGeneral({ pillColor: v }), "Pill color"),
      ),
      field(
        "Accent color",
        undefined,
        colorPicker(settings.general.accentColor, theme.accent, (v) => setGeneral({ accentColor: v }), "Accent color"),
      ),
    ),
    h(
      "section",
      { class: "card" },
      field(
        "Pill width",
        "At the Normal size.",
        rangeControl(settings.general.pillWidth, { ...WIDTH_RANGE, unit: "px" }, (v) => setGeneral({ pillWidth: v }), "Pill width"),
      ),
      field(
        "Corner curve",
        undefined,
        rangeControl(settings.general.pillCurve, { ...CURVE_RANGE, unit: "%" }, (v) => setGeneral({ pillCurve: v }), "Corner curve"),
      ),
    ),
    h(
      "section",
      { class: "card" },
      field(
        "Theme",
        theme.name,
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
    ...header("Layout", "Drag to reorder."),
    h(
      "div",
      { class: "slots" },
      slotList({
        title: "Left of the pill",
        hint: "In priority order.",
        ids: glance.left,
        candidates: glanceable,
        onChange: (left) => setLayout({ ...settings.layout, glance: { ...glance, left } }),
      }),
      slotList({
        title: "Right of the pill",
        hint: "In priority order.",
        ids: glance.right,
        candidates: glanceable,
        onChange: (right) => setLayout({ ...settings.layout, glance: { ...glance, right } }),
      }),
      slotList({
        title: "Tabs",
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
    ...header("Shortcuts"),
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
      : h("p", { class: "lead" }, "No shortcuts."),
    h("p", { class: "note" }, "Win + a single letter is reserved by Windows: add Shift or Alt."),
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
    ...header("Widgets"),
    ...plugins.map((p) => {
      const fields = standardFields(p.options ?? {});
      const { before, after } = aroundPanel(p.options ?? {});
      const control = ([key, f]: [string, Field]) => optionControl(f, values[key], (v) => setOption(p.id, key, v), pickFolder);
      const values = resolve(p.options ?? {}, settings.options[p.id]) as Record<string, unknown>;
      // A plugin's own controls, under its options: given services in the app only (not the preview).
      const panel = p.settingsPanel && h("div", { class: "plugin-panel" });
      if (panel && p.settingsPanel) {
        if (!inTauri) panel.append(h("p", { class: "no-options" }, "More setup is available in the app."));
        else {
          const host = {
            options: () => resolve(p.options ?? {}, settings.options[p.id]) as never,
            setOptions: (patch: Readonly<Record<string, unknown>>) =>
              commit({ ...settings, options: { ...settings.options, [p.id]: { ...settings.options[p.id], ...patch } } }),
          };
          const stop = p.settingsPanel(panel, tauriServices as never, host);
          if (stop) panelStops.push(stop);
        }
      }
      return h(
        "section",
        { class: "card", id: `card-${p.id}` },
        h(
          "div",
          { class: "card-head" },
          h("span", { class: "ico", "aria-hidden": "true" }, icon(p.icon)),
          h("div", { class: "grow" }, h("h2", {}, p.label), h("p", {}, p.description)),
          h(
            "span",
            { class: "badge", "data-placed": String(placesOf(p.id).length > 0) },
            placesOf(p.id).join(" · ") || "Not placed",
          ),
        ),
        ...before.map(control),
        ...(panel ? [panel] : []),
        ...after.map(control),
        ...(!fields.length && !panel ? [h("p", { class: "no-options" }, "No options.")] : []),
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
    const taken = new Set([...extensionRules.taken, ...[...loaded.values()].flatMap((e) => idOf(e) ?? [])]);
    for (const ext of await loadExtensions(fresh, { ...extensionRules, taken }, importer)) loaded.set(ext.file, ext);
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

const FILE = `<path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M9.5 2.5V5H12"/>`;
const PLAY = `<path d="M5 3.5v9l7.5-4.5z"/>`;
const SPARKLE = `<path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7Z"/>`;
const PILL = `<path d="M2.5 4.5h11v1.5a3 3 0 0 1-3 3h-5a3 3 0 0 1-3-3z"/>`;

/** The startup animations to pick from: built-in ones, then those from enabled files. */
const greetingChoices = () => [
  ...greetings.map((g) => ({ value: g.id, label: g.label })),
  ...[...loaded.values()].flatMap((e) => (e.greeting && settings.extensions.includes(e.file) ? [{ value: e.greeting.id, label: e.greeting.label, badge: "Plugin" }] : [])),
  { value: NO_GREETING, label: "None" },
];

/** The pill styles to pick from: built-in ones, then those from enabled files. */
function styleChoices(): { styles: readonly AnyStyle[]; options: SelectOption[] } {
  const extra = [...loaded.values()].flatMap((e) => (e.style && settings.extensions.includes(e.file) ? [e.style] : []));
  return {
    styles: [...styles, ...extra],
    options: [
      ...styles.map((st) => ({ value: st.id, label: st.label, detail: st.description })),
      ...extra.map((st) => ({ value: st.id, label: st.label, detail: st.description, badge: "Plugin" })),
    ],
  };
}

/** The startup animation's drop-down, and a button that plays the one shown on the island. */
function greetingPicker(choices: ReturnType<typeof greetingChoices>, chosen: string): HTMLElement {
  let shown = chosen;
  const play = button(icon(PLAY), () => {
    store.playGreeting(shown).catch((e: unknown) => setStatus("error", `Couldn't play it: ${String(e)}`));
  }, { class: "secondary icon-only", "aria-label": "Play", title: "Play" });
  const update = () => (play.disabled = shown === NO_GREETING);
  const list = select(choices, chosen, (greeting) => {
    shown = greeting;
    update();
    setGeneral({ greeting });
  }, "Startup animation");
  update();
  return h("div", { class: "greeting-picker" }, list.el, play);
}

// ---------- the community store ----------

/** The store's plugins, read when the Plugins section first opens and again on Refresh; `null` until then. */
let shelf: { offers: Offer[]; problem: string | null } | null = null;
let readingShelf = false;
/** The store plugin being downloaded, and why the last downloads failed. */
let installing: string | null = null;
const installFailures = new Map<string, string>();
const STORE = `<path d="M2.5 6 3.5 2.5h9l1 3.5"/><path d="M2.5 6a1.85 1.85 0 0 0 3.7 0 1.85 1.85 0 0 0 3.6 0 1.85 1.85 0 0 0 3.7 0"/><path d="M3.5 8v5.5h9V8M6.5 13.5V10h3v3.5"/>`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readShelf(): Promise<void> {
  readingShelf = true;
  shelf = await community.catalog().then(
    (s) => ({ offers: s.plugins, problem: null }),
    (e: unknown) => ({ offers: [], problem: message(e) }),
  );
  readingShelf = false;
}

/** Downloads a store plugin into the folder; it then shows above, off, like any file put there. */
async function installOffer(offer: Offer): Promise<void> {
  installing = offer.id;
  installFailures.delete(offer.id);
  render();
  try {
    await community.install(offer.id);
    await rescan();
  } catch (e) {
    installFailures.set(offer.id, message(e));
  } finally {
    installing = null;
    render();
  }
}

function storeCards(): Node[] {
  if (!shelf) {
    if (!readingShelf) void readShelf().then(() => section === "plugins" && render());
    return [h("p", { class: "lead" }, "Reading the store…")];
  }
  if (shelf.problem) return [h("p", { class: "note failed" }, `Couldn't read the store: ${shelf.problem}`)];
  if (!shelf.offers.length) return [h("p", { class: "lead" }, "The store has no plugins yet.")];
  const files = found.plugins.map((p) => p.file);
  return shelf.offers.map((offer) => {
    const state = offerState(offer, files);
    const failure = installFailures.get(offer.id);
    const busy = installing === offer.id;
    const action = button(
      busy ? "Installing…" : state === "update" ? "Update" : "Install",
      () => void installOffer(offer),
      { class: "secondary", ...(state === "unavailable" || installing ? { disabled: "" } : {}) },
    );
    const repo = button("Repository", () => void community.openRepo(offer.id).catch(() => {}), { class: "secondary", title: offer.repo });
    const detail = failure ? `Couldn't install it: ${failure}` : offer.problem ? `Install it by hand: ${offer.problem}.` : offer.description;
    const card = h(
      "section",
      { class: "card store-card" },
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "ico", "aria-hidden": "true" }, icon(STORE)),
        h("div", { class: "grow" }, h("h2", {}, offer.name), h("p", {}, detail)),
        ...(state === "update" ? [h("span", { class: "badge", "data-placed": "true" }, "Installed")] : []),
        repo,
        action,
      ),
    );
    if (failure || offer.problem) card.classList.add("failed");
    return card;
  });
}

function pluginsSection(): Node[] {
  const rows = fileRows(found.plugins, settings.extensions, loaded);
  const list = rows.map((row) => {
    const title = row.plugin?.label ?? row.greeting?.label ?? row.style?.label ?? row.file;
    const detail = row.problem
      ? `Can't be used: ${row.problem}`
      : row.plugin
        ? `${row.plugin.description}${row.needs.length ? ` Uses: ${row.needs.join(", ")}.` : ""}`
        : row.greeting
          ? "Startup animation, chosen in Appearance."
          : row.style
            ? "Pill style, chosen in Appearance."
          : row.on
          ? "Loading…"
          : "Off";
    const card = h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "ico", "aria-hidden": "true" }, icon(row.plugin?.icon ?? (row.greeting ? SPARKLE : row.style ? PILL : FILE))),
        h("div", { class: "grow" }, h("h2", {}, title), h("p", {}, detail)),
        switchControl(row.on, (on) => void toggleFile(row.file, on).then(render), `Use ${title}`),
      ),
    );
    if (row.problem) card.classList.add("failed");
    return card;
  });
  return [
    ...header("Plugins"),
    h("p", { class: "note" }, "Plugins run with the island's permissions: only turn on those you trust."),
    ...(list.length ? list : [h("p", { class: "lead" }, "No plugins. Add .js files to the plugins folder.")]),
    h(
      "div",
      { class: "actions" },
      button("Open plugins folder", () => void folder.openDir().then(rescan).then(render).catch(() => {}), { class: "secondary", ...(inTauri ? {} : { disabled: "" }) }),
      button("Refresh", () => void Promise.all([rescan(), readShelf()]).then(render), { class: "secondary" }),
    ),
    ...(found.dir ? [h("p", { class: "note" }, found.dir)] : []),
    h("h2", { class: "subhead" }, "Community store"),
    h("p", { class: "note" }, "Plugins made by others, downloaded from their repository. They are installed off: read the code, then turn them on above."),
    ...storeCards(),
  ];
}

const UPDATE_ICONS: Record<Tone, string> = {
  ok: `<circle cx="8" cy="8" r="6"/><path d="M5.6 8.1l1.7 1.7 3.2-3.5"/>`,
  accent: `<path d="M8 2.5v7M5 6.75l3 3 3-3"/><path d="M3 11v1.25c0 .7.55 1.25 1.25 1.25h7.5c.7 0 1.25-.55 1.25-1.25V11"/>`,
  busy: `<path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3"/><path d="M13.25 2.5v2.75H10.5"/>`,
  hot: `<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 10.9v.01"/>`,
  muted: `<path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3"/><path d="M13.25 2.5v2.75H10.5"/>`,
};

/** Label of the disabled button while the updater is busy, so the row keeps its shape. */
const BUSY_LABEL: Partial<Record<Report["state"]["kind"], string>> = { checking: "Checking…", downloading: "Installing…", installing: "Installing…" };

/** The Updates card: running version, what the updater is doing, its progress, the notes of what's new, and the one action it offers. */
function updatesCard(): HTMLElement {
  const card = h("section", { class: "card update", id: "card-updates" });
  if (!update) {
    card.append(h("div", { class: "update-head" }, h("div", { class: "grow" }, h("p", { class: "update-text" }, "Loading…"))));
    return card;
  }
  const { state } = update;
  const view = describe(state);
  card.dataset.tone = view.tone;
  const fail = (e: unknown) => setStatus("error", `Update: ${String(e)}`);

  const control =
    view.action === "install"
      ? button("Install and restart", () => void updater.install().catch(fail), { class: "primary" })
      : button(BUSY_LABEL[state.kind] ?? "Check now", () => void updater.check().catch(fail), { class: "secondary", ...(view.action ? {} : { disabled: "" }) });

  card.append(
    h(
      "div",
      { class: "update-head" },
      h("span", { class: "ico update-ico", "aria-hidden": "true" }, icon(UPDATE_ICONS[view.tone])),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "update-title" }, h("h2", {}, `AiN ${update.current}`), ...(view.badge ? [h("span", { class: "update-badge" }, view.badge)] : [])),
        h("p", { class: "update-text", role: "status" }, view.text),
      ),
      control,
    ),
  );

  if (view.progress !== null) {
    const bar = h("div", { class: "progress update-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(view.progress * 100)) }, h("i"));
    bar.style.setProperty("--p", String(view.progress));
    card.append(bar);
  }

  if (state.kind === "available" && state.notes) {
    const lines = noteLines(state.notes).map((l) => (l.heading ? h("h3", {}, l.text) : l.text ? h("p", {}, l.text) : h("div", { class: "gap" })));
    card.append(h("div", { class: "update-notes" }, h("div", { class: "update-notes-label" }, `What's new in ${state.version}`), h("div", { class: "update-notes-body" }, ...lines)));
  }

  card.append(
    h(
      "div",
      { class: "update-foot" },
      h("span", {}, state.kind === "disabled" ? "Download new versions by hand from the releases page." : "Checked at launch, then every 6 hours. Nothing installs without you."),
      ...(update.releases ? [button("All releases ↗", () => void updater.openReleases().catch(fail), { class: "link" })] : []),
    ),
  );
  return card;
}

/** Redraws just the Updates card, so download progress doesn't rebuild the whole section. */
function paintUpdates() {
  if (section !== "about") return;
  const card = document.getElementById("card-updates");
  if (card) card.replaceWith(updatesCard());
  else render();
}

function about(): Node[] {
  let armed = false;
  const reset = button("Reset", () => {
    if (!armed) {
      armed = true;
      reset.textContent = "Click again to confirm";
      reset.classList.add("danger");
      return;
    }
    commit(fallback, true);
  }, { class: "secondary" });
  return [
    ...header("About", "AiN, All I Needed — a Dynamic Island for your desktop."),
    updatesCard(),
    h("section", { class: "card" }, field("Reset all settings", undefined, reset)),
  ];
}

const RENDER: Record<Section, () => Node[]> = { appearance, general, layout, shortcuts, widgets, plugins: pluginsSection, about };

function render() {
  for (const b of nav.querySelectorAll<HTMLButtonElement>("button[data-section]")) {
    if (b.dataset.section === section) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  const scroll = content.scrollTop;
  for (const stop of panelStops) stop();
  panelStops = [];
  content.replaceChildren(...RENDER[section]());
  content.scrollTop = scroll;
  if (scrollToCard) {
    const card = document.getElementById(`card-${scrollToCard}`);
    // Plugins from the folder may still be loading: try again on the next render.
    if (card) {
      scrollToCard = null;
      card.scrollIntoView({ block: "start" });
      card.classList.add("highlight");
    }
  }
}

/** Shows a place asked for from elsewhere, e.g. the island's "Set up in Settings". */
function goTo(target: string) {
  const place = parseTarget(target, Object.keys(SECTIONS));
  if (!place || !isSection(place.section)) return;
  section = place.section;
  scrollToCard = place.card;
  history.replaceState(null, "", `#${section}`);
  render();
}

// ---------- bootstrap ----------

nav.append(
  h("div", { class: "brand" }, h("span", { class: "brand-pill", "aria-hidden": "true" }), "AiN"),
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

void store.onNavigate(goTo);
const showUpdate = (report: Report) => {
  update = report;
  paintUpdates();
};
void updater.watch(showUpdate);
void updater.status().then(showUpdate, () => {});
void rescan().then(render);
