import "./settings.css";
import { type Entry, commandsOf, fromKey, keycaps, shortcutOf, surfaceOf } from "../../commands";
import { button, h, icon } from "../../../sdk/dom";
import { resolve, unset } from "../../../sdk/options";
import type { Layout } from "../../placement";
import type { AnyPlugin, PageHost, PageParams, SettingsHost } from "../../../sdk/plugin";
import {
  CURVE_RANGE,
  DELAY_RANGE,
  type General,
  REVEAL_RANGE,
  WIDTH_RANGE,
  type Settings,
  defaults,
  pageTarget,
  parsePage,
  parseSettings,
  parseTarget,
  placeNew,
  setExtension,
} from "../../settings";
import { type Extension, fileRows, idOf, loadExtensions, storeFields } from "../../extensions";
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
import { type SecretAccess, aroundPanel, colorPicker, field, folderControl, optionControl, rangeControl, segmented, standardFields, switchControl, themeGrid } from "./controls";
import type { Field, Fields } from "../../../sdk/options";
import { memorySecrets } from "../../secrets";
import { settingsPorts } from "./ports";
import { slotList } from "./slots";
import { PROVIDERS_ICON, PROVIDERS_LEAD, providersSection } from "./providers";
import { type EngineValues, enginePanel } from "../../../features/engine";
import { PLUGIN_AI } from "../../ai";
import { NOTIFICATIONS_ICON, NOTIFICATIONS_LEAD, notificationsBody } from "./notifications";
import type { NotificationSettings } from "../../notifications";
import { PRESETS, type Preset, builtInPresets } from "../../providers";
import { type Report, type Tone, demoUpdater, describe, noteLines } from "../../updater";
import { messageOf, onProblem, reportProblem } from "../../../sdk/report";
import { toaster } from "./toasts";
import { type SearchEntry, search } from "./search";

const SAVE_DELAY = 250;
/** Built-in features, then plugins from enabled files that loaded fine. */
let plugins: readonly AnyPlugin[] = catalogue;
const fallback = defaults(defaultLayout);
// The app's backend, or in-memory stand-ins outside Tauri (the browser preview, integration tests).
const { store, popup, folder, importer, community = noCommunity, updater = demoUpdater(), secrets = memorySecrets(), presets: loadPresets = builtInPresets, services = tauriServices, inApp: inTauri } = settingsPorts();
/** The updater's last report, kept current by its events; null until the first one arrives. */
let update: Report | null = null;
/** The AI provider presets, at their addresses once the backend has said (environment overrides). */
let presets: readonly Preset[] = PRESETS;
/** Every command with a shortcut: built-in features', then those of enabled plugin files. */
const entries = (): Entry[] => commandsOf(plugins);
/** Shortcuts the island couldn't register, and why. */
let failures: Record<string, string> = {};

const GRID = `<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>`;
const SEARCH = `<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.5 13.5"/>`;
const CHEVRON = `<path d="M6.5 4 10.5 8l-4 4"/>`;
const MENU = `<path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5"/>`;

const SECTIONS = {
  general: { label: "General", icon: `<path d="M3 4.5h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.75"/><circle cx="10.5" cy="11.5" r="1.75"/>` },
  appearance: {
    label: "Appearance",
    icon: `<path d="M8 1.75a6.25 6.25 0 1 0 0 12.5c.9 0 1.4-.6 1.4-1.3 0-.9-.8-1.2-.8-2 0-.7.6-1.2 1.3-1.2h1.5a2.85 2.85 0 0 0 2.85-2.85C14.25 4.1 11.45 1.75 8 1.75z"/><circle cx="4.9" cy="7.4" r=".9"/><circle cx="7.2" cy="4.7" r=".9"/><circle cx="10.4" cy="5.2" r=".9"/>`,
  },
  layout: { label: "Layout", icon: `<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M2.5 7h11M7 7v6"/>` },
  notifications: { label: "Notifications", icon: NOTIFICATIONS_ICON },
  shortcuts: { label: "Shortcuts", icon: `<rect x="1.75" y="4" width="12.5" height="8" rx="1.75"/><path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h-.5M5 9.5h6"/>` },
  widgets: { label: "Widgets", icon: GRID },
  providers: { label: "AI providers", icon: PROVIDERS_ICON },
  plugins: {
    label: "Plugins",
    icon: `<path d="M6 2.5v3M10 2.5v3"/><path d="M4 5.5h8v2.75a4 4 0 0 1-8 0z"/><path d="M8 12.25v1.25"/>`,
  },
  about: { label: "About", icon: `<circle cx="8" cy="8" r="6"/><path d="M8 7.25v3.5M8 5.25v.01"/>` },
} as const;
type Section = keyof typeof SECTIONS;

let settings: Settings = fallback;
const isSection = (s: string): s is Section => s in SECTIONS;
// Opened at a place ("widgets:dictation" is that widget's page; "plugins:x" a card to bring into view).
const opened = parseTarget(location.hash.slice(1), Object.keys(SECTIONS));
let section: Section = opened && isSection(opened.section) ? opened.section : "general";
/** The widget whose page is shown, under Widgets; null for the list of them all. */
let widget: string | null = section === "widgets" ? (opened?.card ?? null) : null;
let scrollToCard: string | null = section === "widgets" ? null : (opened?.card ?? null);
/** A row to bring into view and outline once drawn, by its label: where a search result leads. */
let scrollToField: string | null = null;
/** What's typed in the search box; while it isn't empty, the results take the page. */
let query = "";

/** A plugin's page, shown instead of a section; leaving it goes back to `back`, at the plugin's card. */
type OpenPage = { readonly id: string; readonly params: PageParams; readonly back: Section };
// Or opened at a plugin's page ("page:notes?id=3"), from the island: leaving it shows the plugin's card.
const openedPage = parsePage(location.hash.slice(1));
let page: OpenPage | null = openedPage && { ...openedPage, back: "widgets" };
/** The page as drawn, kept across redraws so what the user typed stays, until it's left. */
let drawnPage: { key: string; nodes: Node[]; stop: (() => void) | undefined } | null = null;
/** Set once the plugins folder was read: a page's plugin that isn't loaded by then isn't coming. */
let scanned = false;
/** Stop functions of the plugins' settings panels on screen, called before they're redrawn. */
let panelStops: (() => void)[] = [];
let pending: ReturnType<typeof setTimeout> | undefined;

const content = h("main", { class: "content" });
const status = h("div", { class: "status", "data-state": "saved", role: "status" }, "Saved");
const searchBox = h("input", { class: "search-input", type: "search", placeholder: "Search settings", spellcheck: "false", "aria-label": "Search settings" });
const navList = h("div", { class: "nav-list" });
const navFoot = h("div", { class: "nav-foot" });
const searchField = h("label", { class: "search" }, icon(SEARCH), searchBox, h("kbd", { class: "search-key", "aria-hidden": "true" }, "Ctrl F"));
const brand = () => h("div", { class: "brand" }, h("span", { class: "brand-pill", "aria-hidden": "true" }), "AiN", h("span", { class: "brand-sub" }, "Settings"));
const nav = h("nav", { class: "nav", id: "settings-nav", "aria-label": "Settings sections" }, brand(), searchField, navList, navFoot);
// In a narrow window the menu is a drawer, opened from a bar at the top that holds the search box.
const menuButton = button(icon(MENU), () => setMenu(app.dataset.menu !== "open"), {
  class: "menu-button",
  "aria-label": "Menu",
  "aria-controls": "settings-nav",
  "aria-expanded": "false",
});
const topbar = h("header", { class: "topbar" }, menuButton, brand());
const backdrop = h("div", { class: "nav-backdrop", "aria-hidden": "true" });
const app = h("div", { class: "app", "data-menu": "closed" }, topbar, nav, content, backdrop);

/** Opens or closes the menu's drawer (narrow windows only; wide, the menu is always there). */
function setMenu(open: boolean) {
  app.dataset.menu = open ? "open" : "closed";
  menuButton.setAttribute("aria-expanded", String(open));
  if (open) nav.querySelector<HTMLElement>("[aria-current=page]")?.focus();
}
backdrop.addEventListener("click", () => setMenu(false));
nav.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && app.dataset.menu === "open") {
    setMenu(false);
    menuButton.focus();
  }
});
// Picking a place closes the drawer.
nav.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("button")) setMenu(false);
});

/** Narrow, the search box sits in the top bar, always in reach; wide, at the top of the menu. */
const narrow = window.matchMedia("(max-width: 760px)");
const placeSearch = () => {
  if (narrow.matches) return topbar.append(searchField);
  nav.insertBefore(searchField, navList);
  setMenu(false);
};
narrow.addEventListener("change", placeSearch);
placeSearch();
const toasts = toaster();

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
      (e: unknown) => {
        setStatus("error", "Not saved");
        reportProblem("Your changes weren't saved", e, "SETTINGS_SAVE");
      },
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
const setNotifications = (patch: Partial<NotificationSettings>, redraw = false) =>
  commit({ ...settings, notifications: { ...settings.notifications, ...patch } }, redraw);
const setShortcut = (id: string, value: string | null) => commit({ ...settings, shortcuts: { ...settings.shortcuts, [id]: value } }, true);
const resetShortcut = (id: string) => {
  const { [id]: _, ...rest } = settings.shortcuts;
  commit({ ...settings, shortcuts: rest }, true);
};
const setOption = (id: string, key: string, value: unknown) => {
  commit({ ...settings, options: { ...settings.options, [id]: { ...settings.options[id], [key]: value } } });
  repaintSetup(id);
};
/** Back to the defaults: every option of the plugin but its secrets, which have their own Remove. */
const resetOptions = (id: string) => {
  const { [id]: _, ...rest } = settings.options;
  commit({ ...settings, options: rest }, true);
  toasts.note("Back to the defaults");
};

// ---------- the parts of a page ----------

/** What a page shows at its top, pinned while the rest scrolls: where it is, its name, what it's for, and its actions. */
type Head = {
  readonly crumbs?: readonly (readonly [string, () => void])[];
  readonly title: string;
  readonly lead?: string | undefined;
  readonly icon?: string | undefined;
  readonly badges?: readonly Node[];
  readonly actions?: readonly Node[];
};
type Page = Head & { readonly body: readonly Node[] };

function pageHead(head: Head): HTMLElement {
  const crumbs = head.crumbs ?? [];
  return h(
    "header",
    { class: "page-head" },
    ...(crumbs.length
      ? [h("div", { class: "crumbs", role: "navigation", "aria-label": "You are in" }, ...crumbs.flatMap(([label, go]) => [button(label, go, { class: "crumb" }), h("span", { class: "crumb-sep", "aria-hidden": "true" }, "›")]))]
      : []),
    h(
      "div",
      { class: "page-title" },
      ...(head.icon ? [h("span", { class: "ico page-ico", "aria-hidden": "true" }, icon(head.icon))] : []),
      h("div", { class: "grow" }, h("div", { class: "title-row" }, h("h1", {}, head.title), ...(head.badges ?? [])), ...(head.lead ? [h("p", { class: "lead" }, head.lead)] : [])),
      ...(head.actions?.length ? [h("div", { class: "page-actions" }, ...head.actions)] : []),
    ),
  );
}

/** Settings that belong together, under a title saying what they're about. */
function group(title: string | null, ...rows: Node[]): HTMLElement {
  return h("section", { class: "group" }, ...(title ? [h("h2", { class: "group-title" }, title)] : []), h("div", { class: "card" }, ...rows));
}

/** A titled group around a card that draws itself. */
const titled = (title: string, card: HTMLElement): HTMLElement => h("section", { class: "group" }, h("h2", { class: "group-title" }, title), card);

/** A plugin page's title and why it shows nothing else. */
function header(title: string, lead: string) {
  return [h("h1", {}, title), h("p", { class: "lead" }, lead)];
}

// ---------- sections ----------

function general(): Page {
  const autostart = switchControl(false, (on) => {
    store.setAutostart(on).catch((e: unknown) => {
      autostart.setAttribute("aria-checked", String(!on));
      reportProblem("Couldn't change Launch at login", e, "AUTOSTART");
    });
  }, "Launch at login");
  store.autostart().then((on) => autostart.setAttribute("aria-checked", String(on)), () => (autostart.disabled = true));
  return {
    title: "General",
    lead: "How AiN starts, and how quickly the island answers the pointer.",
    body: [
      group("Startup", field("Launch at login", "Starts AiN when you sign in, so the island is there from the start.", autostart)),
      group(
        "Island",
        field(
          "Open delay",
          "How long the pointer rests on the pill before the island opens.",
          rangeControl(settings.general.openDelay, { ...DELAY_RANGE, unit: "ms" }, (v) => setGeneral({ openDelay: v }), "Open delay"),
        ),
        field(
          "Close delay",
          "How long the island stays open once the pointer leaves it.",
          rangeControl(settings.general.closeDelay, { ...DELAY_RANGE, unit: "ms" }, (v) => setGeneral({ closeDelay: v }), "Close delay"),
        ),
        field(
          "Hide the pill",
          "With the Hidden style, the pill only shows while the pointer rests at the top center of the screen.",
          button("Appearance", () => goTo("appearance"), { class: "secondary" }),
        ),
      ),
      group("Network", ...networkRows()),
      group(
        "App",
        field(
          "Quit AiN",
          "Closes the island and this window. Start AiN again from the Start menu.",
          button("Quit", () => void store.quit().catch((e: unknown) => reportProblem("Couldn't quit AiN", e, "QUIT")), { class: "secondary danger" }),
        ),
      ),
    ],
  };
}

/** Closed networks: servers with a self-signed or internal certificate, and models without internet. */
function networkRows(): HTMLElement[] {
  const anyCertificate = switchControl(settings.general.acceptAnyCertificate, (on) => {
    setGeneral({ acceptAnyCertificate: on });
    if (on) toasts.note("Certificates are no longer checked: use this on a network you trust only");
  }, "Accept any certificate");
  return [
    field(
      "Accept any certificate",
      "Connects to servers whose certificate isn't trusted (self-signed, internal CA): AI providers, the store, downloads and updates. Anyone on the network could then read and change the traffic. A company CA installed on the system is trusted without this.",
      anyCertificate,
    ),
    field(
      "Models source",
      "Without internet, models come from here: a folder (USB drive, network share) or an http(s) address laid out like a models folder. Copy the models folder of a connected computer to make one.",
      folderControl(settings.general.modelsSource, "The internet", pickFolder, (v) => setGeneral({ modelsSource: v }), "Models source"),
      true,
    ),
  ];
}

const PILL_SIZES: readonly { value: PillSize; label: string }[] = [
  { value: "low", label: "Low profile" },
  { value: "normal", label: "Normal" },
  { value: "large", label: "Large" },
];

/** The pill's style and size, the reveal delay of a hidden style, its shape, and the style's own options. */
function pillRows(): HTMLElement[] {
  const choices = styleChoices();
  const style = styleById(choices.styles, settings.general.style);
  const values = resolve(style.options ?? {}, settings.options[style.id]) as Record<string, unknown>;
  return [
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
    field(
      "Pill width",
      "At the Normal size.",
      rangeControl(settings.general.pillWidth, { ...WIDTH_RANGE, unit: "px" }, (v) => setGeneral({ pillWidth: v }), "Pill width"),
    ),
    field(
      "Corner curve",
      "From square corners to a full pill.",
      rangeControl(settings.general.pillCurve, { ...CURVE_RANGE, unit: "%" }, (v) => setGeneral({ pillCurve: v }), "Corner curve"),
    ),
    ...standardFields(style.options ?? {}).map(([key, f]) => optionControl(f, values[key], (v) => setOption(style.id, key, v), pickFolder)),
  ];
}

function appearance(): Page {
  const theme = themeById(settings.general.theme);
  const choices = greetingChoices();
  // A choice whose plugin is gone plays the default.
  const chosen = choices.some((c) => c.value === settings.general.greeting) ? settings.general.greeting : greetings[0]!.id;
  return {
    title: "Appearance",
    lead: "The pill's shape and colors, and what it plays when AiN starts.",
    body: [
      group("Pill", ...pillRows()),
      group(
        "Colors",
        field(
          "Theme",
          theme.name,
          themeGrid(THEMES, theme.id, (th) => setGeneral({ theme: th.id, pillColor: th.bg, accentColor: th.accent }, true)),
          true,
        ),
        field("Pill color", "The island's background.", colorPicker(settings.general.pillColor, theme.bg, (v) => setGeneral({ pillColor: v }), "Pill color")),
        field("Accent color", "Buttons, progress and highlights, here too.", colorPicker(settings.general.accentColor, theme.accent, (v) => setGeneral({ accentColor: v }), "Accent color")),
      ),
      group("Startup", field("Startup animation", "Played on the island each time AiN starts.", greetingPicker(choices, chosen))),
    ],
  };
}

function layout(): Page {
  const { glance, tabs } = settings.layout;
  const glanceable = plugins.filter((p) => p.slots.includes("glance"));
  return {
    title: "Layout",
    lead: "What the island shows, and in which order: drag the widgets, or use their arrows. When space runs out, the first ones stay.",
    actions: [button("Restore default layout", () => setLayout(defaultLayout), { class: "secondary" })],
    body: [
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
          hint: "When the island opens.",
          ids: tabs,
          candidates: plugins.filter((p) => p.slots.includes("tab")),
          onChange: (next) => setLayout({ ...settings.layout, tabs: next }),
        }),
      ),
    ],
  };
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
    button("Try it", () => popup.open(entry.id, surfaceOf(entry)).catch((e: unknown) => reportProblem(`Couldn't try ${entry.command.label}`, e, "SHORTCUT_TRY")), {
      class: "secondary",
      ...(inTauri ? {} : { disabled: "", title: "Only in the app" }),
    }),
  );
}

function notifications(): Page {
  const notifiers = [...loaded.values()].flatMap((e) => (e.notifier && settings.extensions.includes(e.file) ? [{ id: e.notifier.id, label: e.notifier.label }] : []));
  return {
    title: "Notifications",
    lead: NOTIFICATIONS_LEAD,
    body: notificationsBody(settings.notifications, { sources: plugins.map((p) => ({ id: p.id, label: p.label })), notifiers }, setNotifications, group),
  };
}

function shortcuts(): Page {
  return {
    title: "Shortcuts",
    lead: "Keys that work anywhere, even while another app has the focus. Click Change, then press the new keys.",
    body: [
      entries().length
        ? group(
            null,
            ...entries().map((e) => {
              const failed = failures[e.id];
              const hint = failed ? `${e.command.description} — ${failed}: pick another shortcut.` : e.command.description;
              const row = field(`${e.command.label} · ${e.plugin.label}`, hint, recorder(e));
              if (failed) row.classList.add("failed");
              return row;
            }),
          )
        : h("p", { class: "lead" }, "No shortcuts."),
      h("p", { class: "note" }, "Win + a single letter is reserved by Windows: add Shift or Alt."),
    ],
  };
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

/** The system folder (or file) picker; null when cancelled or outside the app. */
async function pickFolder(current: string, directory = true): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({ directory, multiple: false, ...(current ? { defaultPath: current } : {}) });
  return typeof chosen === "string" ? chosen : null;
}

/** Reaches one of a plugin's secrets in the credential store; saving one may complete its setup. */
const secretAccess = (id: string, key: string): SecretAccess => ({
  saved: () => secrets.saved(id, [key]).then(([saved]) => saved === true),
  save: (value) => secrets.set(id, key, value).then(() => repaintSetup(id)),
});

/** The fields of the badges saying a plugin needs setting up, by plugin id. */
const setupFields = new Map<string, Fields>();

/** "Needs setup", while a required option is left empty; its tooltip says which. Hidden otherwise. */
function setupBadge(id: string, fields: Fields): HTMLElement {
  setupFields.set(id, fields);
  const badge = h("span", { class: "badge needs-setup", "data-setup": id });
  badge.hidden = true;
  void paintSetup(badge, id, fields);
  return badge;
}

/** The menu's dot beside a widget that needs setting up, kept with its badges. */
function setupDot(id: string, fields: Fields): HTMLElement {
  setupFields.set(id, fields);
  const dot = h("span", { class: "nav-dot", "data-setup": id, "aria-hidden": "true" });
  dot.hidden = true;
  void paintSetup(dot, id, fields);
  return dot;
}

async function paintSetup(badge: HTMLElement, id: string, fields: Fields): Promise<void> {
  const keys = Object.entries(fields).flatMap(([key, f]) => (f.kind === "secret" && f.required ? [key] : []));
  // Unreadable, the credential store can't say a secret is missing: no badge rather than a false one.
  const saved = keys.length ? await secrets.saved(id, keys).catch(() => keys.map(() => true)) : [];
  const missing = unset(fields, settings.options[id], (key) => saved[keys.indexOf(key)] === true);
  badge.hidden = missing.length === 0;
  if (!badge.classList.contains("nav-dot")) badge.textContent = "Needs setup";
  badge.title = missing.length ? `Still to fill in: ${missing.join(", ")}` : "";
}

/** Brings a plugin's "Needs setup" badges up to date after one of its options changed. */
function repaintSetup(id: string): void {
  const fields = setupFields.get(id);
  if (!fields) return;
  for (const badge of document.querySelectorAll<HTMLElement>(`[data-setup="${id}"]`)) void paintSetup(badge, id, fields);
}

/** Under a plugin's options: back to their defaults. */
function resetRow(id: string, fields: Fields): Node[] {
  const kinds = Object.values(fields).map((f) => f.kind);
  if (!kinds.some((k) => k !== "secret")) return [];
  return [
    h(
      "div",
      { class: "card-foot" },
      h("span", {}, kinds.includes("secret") ? "Secrets stay saved: remove them above." : ""),
      button("Reset to defaults", () => resetOptions(id), { class: "link" }),
    ),
  ];
}

/** A plugin's option controls, with its own settings panel among them, then a way back to the defaults. */
function optionRows(p: AnyPlugin | AnyStyle | { readonly id: string; readonly options: Fields }): Node[] {
  const { before, after } = aroundPanel(p.options ?? {});
  const values = resolve(p.options ?? {}, settings.options[p.id]) as Record<string, unknown>;
  const control = ([key, f]: [string, Field]) =>
    optionControl(f, values[key], (v) => setOption(p.id, key, v), pickFolder, f.kind === "secret" ? secretAccess(p.id, key) : undefined);
  // A plugin's own controls, under its options: given services in the app only (not the preview).
  const setUp = "settingsPanel" in p ? p.settingsPanel : undefined;
  const panel = setUp && h("div", { class: "plugin-panel" });
  if (panel && setUp) {
    if (!inTauri) panel.append(h("p", { class: "no-options" }, "More setup is available in the app."));
    else {
      const host = {
        options: () => resolve(p.options ?? {}, settings.options[p.id]) as never,
        setOptions: (patch: Readonly<Record<string, unknown>>) =>
          commit({ ...settings, options: { ...settings.options, [p.id]: { ...settings.options[p.id], ...patch } } }),
        openPage: (params?: PageParams) => openPage(p.id, params),
      };
      // A plugin from a file can't break the window: its panel is guarded where it's loaded.
      const stop = setUp.call(p, panel, services as never, host);
      if (stop) panelStops.push(stop);
    }
  }
  return [...before.map(control), ...(panel ? [panel] : []), ...after.map(control), ...resetRow(p.id, p.options ?? {})];
}

/** Where the island shows a widget, in words. */
function placedText(id: string): string {
  const names: Record<string, string> = { Left: "Left of the pill", Right: "Right of the pill", Tabs: "Tabs" };
  const places = placesOf(id);
  return places.length ? places.map((p) => names[p]).join(" · ") : "Not on the island yet: add it in Layout.";
}

/** Every widget, one per row: what it is, where it shows, whether it needs setting up. */
function widgetList(): Page {
  return {
    title: "Widgets",
    lead: "Everything the island can show. Open one to set it up; choose where it shows in Layout.",
    actions: [button("Edit layout", () => goTo("layout"), { class: "secondary" })],
    body: [
      h(
        "div",
        { class: "card list" },
        ...plugins.map((p) => {
          const places = placesOf(p.id);
          return button(
            h(
              "span",
              { class: "list-in" },
              h("span", { class: "ico", "aria-hidden": "true" }, icon(p.icon)),
              h("span", { class: "grow" }, h("span", { class: "list-title" }, p.label), h("span", { class: "list-detail" }, p.description)),
              setupBadge(p.id, p.options ?? {}),
              h("span", { class: "badge", "data-placed": String(places.length > 0) }, places.join(" · ") || "Not placed"),
              h("span", { class: "chevron", "aria-hidden": "true" }, icon(CHEVRON)),
            ),
            () => openWidget(p.id),
            { class: "list-row", "data-widget": p.id },
          );
        }),
      ),
    ],
  };
}

/** One widget's page: where it shows, then its options. */
function widgetPage(p: AnyPlugin): Page {
  const rows = optionRows(p);
  return {
    crumbs: [["Widgets", () => openWidget(null)]],
    title: p.label,
    lead: p.description,
    icon: p.icon,
    badges: [setupBadge(p.id, p.options ?? {})],
    body: [
      group("On the island", field("Shows in", placedText(p.id), button("Edit layout", () => goTo("layout"), { class: "secondary" }))),
      titled(
        "Options",
        h("section", { class: "card", id: `card-${p.id}`, "data-title": p.label }, ...(rows.length ? rows : [h("p", { class: "no-options" }, "No options.")])),
      ),
    ],
  };
}

function widgets(): Page {
  const shown = widget ? plugins.find((p) => p.id === widget) : undefined;
  return shown ? widgetPage(shown) : widgetList();
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
    store.playGreeting(shown).catch((e: unknown) => reportProblem("Couldn't play the startup animation", e, "GREETING_PLAY"));
  }, { class: "secondary icon-only", "aria-label": "Play", title: "Play it on the island" });
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
/** The store plugin being downloaded. */
let installing: string | null = null;
const FOLDER = `<path d="M2.5 4.5c0-.55.45-1 1-1h3l1.5 1.5h4.5c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1h-9c-.55 0-1-.45-1-1z"/>`;
const STORE = `<path d="M2.5 6 3.5 2.5h9l1 3.5"/><path d="M2.5 6a1.85 1.85 0 0 0 3.7 0 1.85 1.85 0 0 0 3.6 0 1.85 1.85 0 0 0 3.7 0"/><path d="M3.5 8v5.5h9V8M6.5 13.5V10h3v3.5"/>`;

async function readShelf(): Promise<void> {
  readingShelf = true;
  shelf = await community.catalog().then(
    (s) => ({ offers: s.plugins, problem: null }),
    (e: unknown) => {
      reportProblem("Couldn't read the community store", e, "STORE_READ");
      return { offers: [], problem: messageOf(e) };
    },
  );
  readingShelf = false;
}

/** Downloads a store plugin into the folder; it then shows above, off, like any file put there. */
async function installOffer(offer: Offer): Promise<void> {
  installing = offer.id;
  render();
  try {
    await community.install(offer.id);
    await rescan();
    toasts.note(`${offer.name} is installed: turn it on above`);
  } catch (e) {
    reportProblem(`Couldn't install ${offer.name}`, e, "STORE_INSTALL");
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
  if (shelf.problem) return [h("p", { class: "note empty" }, "The store isn't available right now. Refresh to try again.")];
  if (!shelf.offers.length) return [h("p", { class: "lead" }, "The store has no plugins yet.")];
  const files = found.plugins.map((p) => p.file);
  return shelf.offers.map((offer) => {
    const state = offerState(offer, files);
    const busy = installing === offer.id;
    const action = button(
      busy ? "Installing…" : state === "update" ? "Update" : "Install",
      () => void installOffer(offer),
      { class: state === "update" ? "secondary" : "primary", ...(state === "unavailable" || installing ? { disabled: "" } : {}) },
    );
    const repo = button("Repository", () => void community.openRepo(offer.id).catch((e: unknown) => reportProblem("Couldn't open the repository", e, "STORE_REPO")), {
      class: "link",
      title: offer.repo,
    });
    const detail = offer.problem ? `Install it by hand: ${offer.problem}.` : offer.description;
    const card = h(
      "section",
      { class: "card store-card" },
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "ico", "aria-hidden": "true" }, icon(STORE)),
        h(
          "div",
          { class: "grow" },
          h("div", { class: "title-row" }, h("h2", {}, offer.name), ...(state === "update" ? [h("span", { class: "badge", "data-placed": "true" }, "Installed")] : [])),
          h("p", {}, detail),
        ),
        h("div", { class: "card-actions" }, repo, action),
      ),
    );
    if (offer.problem) card.classList.add("failed");
    return card;
  });
}

/** The options a store plugin declares in the store, for setting it up before it's on; null for none or unusable ones. */
function declaredFields(offer: Offer | undefined): Fields | null {
  const fields = offer ? storeFields(offer.options) : null;
  if (typeof fields === "string") console.warn(`[settings] store plugin "${offer?.id}": ${fields}`);
  return fields && typeof fields === "object" && Object.keys(fields).length ? fields : null;
}

/** A plugin's options before it is on: the ones its store listing declares, kept under its id. */
function declaredRows(id: string, fields: Fields): Node[] {
  return [h("p", { class: "no-options before-on" }, "Set it up now: it uses these once turned on."), ...optionRows({ id, options: fields })];
}

/** "orbit-clock/index.js" → "Orbit clock": a name for a file whose code hasn't run yet. */
const nameOfFile = (file: string) => {
  const base = file.replace(/\/index\.js$|\.js$/, "").replace(/^.*\//, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : file;
};

/** The plugins folder: where it is, and the two things to do with it. */
function folderBar(): HTMLElement {
  return h(
    "section",
    { class: "card folder-bar" },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "ico", "aria-hidden": "true" }, icon(FOLDER)),
      h("div", { class: "grow" }, h("h2", {}, "Plugins folder"), h("p", { class: "mono", title: found.dir }, found.dir || "Not available in the preview")),
      h(
        "div",
        { class: "card-actions" },
        button("Open", () => void folder.openDir().then(rescan).then(render).catch((e: unknown) => reportProblem("Couldn't open the plugins folder", e, "FOLDER_OPEN")), {
          class: "secondary",
          title: "Open plugins folder",
          ...(inTauri ? {} : { disabled: "" }),
        }),
        button("Refresh", () => void Promise.all([rescan(), readShelf()]).then(render), { class: "secondary" }),
      ),
    ),
  );
}

function pluginsSection(): Page {
  const rows = fileRows(found.plugins, settings.extensions, loaded);
  const offers = shelf?.offers ?? [];
  const list = rows.map((row) => {
    // Off, a file's code hasn't run: borrow its store listing's name, words and options, if it came from there.
    const listed = offers.find((o) => o.file === row.file);
    const declared = !row.plugin && !row.style && !row.greeting && !row.problem ? declaredFields(listed) : null;
    const fields = row.plugin?.options ?? row.style?.options ?? declared ?? {};
    const id = row.plugin?.id ?? row.style?.id ?? listed?.id;
    const title = row.plugin?.label ?? row.greeting?.label ?? row.style?.label ?? listed?.name ?? nameOfFile(row.file);
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
              : (listed?.description ?? "Turn it on to load it.");
    const card = h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "ico", "aria-hidden": "true" }, icon(row.plugin?.icon ?? (row.greeting ? SPARKLE : row.style ? PILL : FILE))),
        h("div", { class: "grow" }, h("h2", {}, title), h("p", {}, detail), h("p", { class: "mono" }, row.file)),
        ...(id ? [setupBadge(id, fields)] : []),
        switchControl(row.on, (on) => void toggleFile(row.file, on).then(render), `Use ${title}`),
      ),
      // Its options are set right here, under the switch: once on, or before for a store plugin that declares them.
      ...(row.plugin ? optionRows(row.plugin) : row.style ? optionRows(row.style) : declared && listed ? declaredRows(listed.id, declared) : []),
    );
    if (row.problem) card.classList.add("failed");
    return card;
  });
  return {
    title: "Plugins",
    lead: "Widgets, pill styles and startup animations made by others. They run with AiN's permissions: only turn on those you trust.",
    body: [
      folderBar(),
      h("h2", { class: "subhead" }, "Installed"),
      ...(list.length ? list : [h("p", { class: "note empty" }, "No plugins yet. Install one from the store below, or add .js files to the plugins folder.")]),
      h("h2", { class: "subhead" }, "Community store"),
      h("p", { class: "note" }, "Plugins made by others, downloaded from their repository. They are installed off: read the code, then turn them on above."),
      ...storeCards(),
    ],
  };
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
  const fail = (what: string, code: string) => (e: unknown) => reportProblem(what, e, code);

  const control =
    view.action === "install"
      ? button("Install and restart", () => void updater.install().catch(fail("Couldn't install the update", "UPDATE_INSTALL")), { class: "primary" })
      : button(BUSY_LABEL[state.kind] ?? "Check now", () => void updater.check().catch(fail("Couldn't check for updates", "UPDATE_CHECK")), {
          class: "secondary",
          ...(view.action ? {} : { disabled: "" }),
        });

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
      ...(update.releases ? [button("All releases ↗", () => void updater.openReleases().catch(fail("Couldn't open the releases page", "UPDATE_RELEASES")), { class: "link" })] : []),
    ),
  );
  return card;
}

/** Redraws just the Updates card, so download progress doesn't rebuild the whole section. */
function paintUpdates() {
  if (section !== "about" || query) return;
  const card = document.getElementById("card-updates");
  if (card) card.replaceWith(updatesCard());
  else render();
}

function about(): Page {
  let armed = false;
  const reset = button("Reset", () => {
    if (!armed) {
      armed = true;
      reset.textContent = "Click again to confirm";
      reset.classList.add("danger");
      return;
    }
    commit(fallback, true);
    toasts.note("Every setting is back to its default");
  }, { class: "secondary" });
  return {
    title: "About",
    lead: "AiN, All I Needed — a Dynamic Island for your desktop.",
    body: [
      titled("Updates", updatesCard()),
      group("Reset", field("Reset all settings", "Puts every setting back to its default. Saved secrets and plugin files stay.", reset)),
    ],
  };
}

/** Which provider and model plugins from the plugins folder may ask (their `ai` service); off by default. */
function pluginAiCard(): HTMLElement {
  const host: Pick<SettingsHost<EngineValues>, "options" | "setOptions"> = {
    options: () => ({ engine: "", remoteModel: "", ...(settings.options[PLUGIN_AI] as Partial<EngineValues> | undefined) }),
    setOptions: (patch) => commit({ ...settings, options: { ...settings.options, [PLUGIN_AI]: { ...settings.options[PLUGIN_AI], ...patch } } }),
  };
  const engine = enginePanel(services.providers, host, "text", () => {}, { label: "Off", detail: "Plugins can't use AI" });
  panelStops.push(engine.stop);
  return h(
    "section",
    { class: "card", id: "card-provider-plugins" },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "ico", "aria-hidden": "true" }, icon(PROVIDERS_ICON)),
      h("div", { class: "grow" }, h("h2", {}, "Plugins"), h("p", {}, "The model plugins from the plugins folder may ask, when they list “ai” in needs. What they send goes to it.")),
    ),
    engine.el,
  );
}

const providers = (): Page => ({
  title: "AI providers",
  lead: PROVIDERS_LEAD,
  body: [
    ...providersSection({
      providers: () => settings.providers,
      save: (next, redraw) => commit({ ...settings, providers: next }, redraw),
      port: services.providers,
      presets,
      pickFile: (current) => pickFolder(current, false),
    }),
    ...(settings.providers.length ? [pluginAiCard()] : []),
  ],
});

const RENDER: Record<Section, () => Page> = { appearance, general, layout, notifications, shortcuts, widgets, providers, plugins: pluginsSection, about };

// ---------- search ----------

/** Settings Settings draws itself, by section: what they're called, what they do, and other words for them. */
const SEARCHABLE: Partial<Record<Section, readonly (readonly [label: string, hint: string, keywords?: string])[]>> = {
  general: [
    ["Launch at login", "Starts AiN when you sign in", "startup boot autostart windows"],
    ["Open delay", "How long the pointer rests on the pill before the island opens", "hover speed"],
    ["Close delay", "How long the island stays open once the pointer leaves it", "hover speed"],
    ["Hide the pill", "Show the pill only at the top center of the screen", "hidden auto-hide games"],
    ["Accept any certificate", "Trust self-signed or internal servers", "tls ssl https certificate proxy insecure"],
    ["Models source", "Get models from a folder or a server without internet", "offline mirror air-gapped usb download"],
    ["Quit AiN", "Closes the island and this window", "exit close stop"],
  ],
  appearance: [
    ["Pill style", "How the pill looks", "notch hidden"],
    ["Size", "Low profile, Normal or Large", "pill size scale"],
    ["Pill width", "At the Normal size", "wide"],
    ["Corner curve", "From square corners to a full pill", "radius round"],
    ["Theme", "The island's colors", "dark light palette"],
    ["Pill color", "The island's background", "colour background"],
    ["Accent color", "Buttons, progress and highlights", "colour"],
    ["Startup animation", "Played on the island when AiN starts", "greeting hello intro"],
  ],
  layout: [
    ["Left of the pill", "Glances shown left of the pill", "order priority"],
    ["Right of the pill", "Glances shown right of the pill", "order priority"],
    ["Tabs", "Tabs when the island opens", "order"],
  ],
  notifications: [
    ["Show as", "In the pill, as a bubble, as a corner toast or a plugin's notifier", "popup toast bubble corner format"],
    ["Duration", "How long one shows", "time seconds sticky"],
    ["Time remaining bar", "A thin line that empties until the notification leaves", "progress countdown timer lifetime"],
    ["Animation", "How they come and go", "motion slide fade"],
    ["Do not disturb", "Notifications go to the history without showing", "dnd quiet silence focus"],
    ["Larger text", "Easier to read at a glance", "accessibility size"],
  ],
  providers: [
    ["Add a provider", "An online service or your own OpenAI-compatible server", "openai groq api key token server"],
    ["Plugins", "The model plugins from the plugins folder may ask", "ai ask llm community"],
  ],
  plugins: [
    ["Plugins folder", "Where plugin files live", "extensions js"],
    ["Community store", "Plugins made by others", "install download extensions"],
  ],
  about: [
    ["Updates", "Check for and install new versions", "version upgrade"],
    ["Reset all settings", "Puts every setting back to its default", "defaults factory"],
  ],
};

/** Everything search can find: the sections' settings, the shortcuts, and every widget with its options. */
function searchEntries(): SearchEntry[] {
  const sections = (Object.entries(SEARCHABLE) as [Section, (typeof SEARCHABLE)[Section] & {}][]).flatMap(([s, rows]) =>
    rows.map(([label, hint, keywords]) => ({ label, hint, keywords, where: SECTIONS[s].label, target: s, field: label })),
  );
  const keys = entries().map((e) => ({
    label: e.command.label,
    hint: e.command.description,
    keywords: `shortcut keys ${e.plugin.label}`,
    where: SECTIONS.shortcuts.label,
    target: "shortcuts",
    field: `${e.command.label} · ${e.plugin.label}`,
  }));
  const widgetEntries = plugins.flatMap((p) => [
    { label: p.label, hint: p.description, keywords: "widget", where: SECTIONS.widgets.label, target: `widgets:${p.id}` },
    ...Object.values(p.options ?? {}).map((f) => ({ label: f.label, hint: f.hint, where: `${SECTIONS.widgets.label} › ${p.label}`, target: `widgets:${p.id}`, field: f.label })),
  ]);
  return [...sections, ...keys, ...widgetEntries];
}

function results(): Page {
  const found = search(query, searchEntries());
  const shown = query.trim();
  return {
    title: "Search",
    lead: found.length ? `${found.length} result${found.length === 1 ? "" : "s"} for “${shown}”` : `Nothing matches “${shown}”. Try another word, or pick a section on the left.`,
    body: found.length
      ? [
          h(
            "div",
            { class: "card list results" },
            ...found.map((r) =>
              button(
                h(
                  "span",
                  { class: "list-in" },
                  h("span", { class: "grow" }, h("span", { class: "list-title" }, r.label), ...(r.hint ? [h("span", { class: "list-detail" }, r.hint)] : [])),
                  h("span", { class: "list-where" }, r.where),
                  h("span", { class: "chevron", "aria-hidden": "true" }, icon(CHEVRON)),
                ),
                () => {
                  clearSearch();
                  scrollToField = r.field ?? null;
                  goTo(r.target);
                },
                { class: "list-row" },
              ),
            ),
          ),
        ]
      : [],
  };
}

function clearSearch() {
  query = "";
  searchBox.value = "";
}

searchBox.addEventListener("input", () => {
  query = searchBox.value;
  content.scrollTop = 0;
  render();
});
searchBox.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && searchBox.value) {
    e.preventDefault();
    clearSearch();
    render();
  } else if (e.key === "ArrowDown" || e.key === "Enter") {
    const first = content.querySelector<HTMLButtonElement>(".results .list-row");
    if (!first) return;
    e.preventDefault();
    if (e.key === "Enter") first.click();
    else first.focus();
  }
});
// Up and down through the results, back to the box from the first.
content.addEventListener("keydown", (e) => {
  const row = (e.target as HTMLElement).closest?.(".results .list-row");
  if (!row || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
  e.preventDefault();
  const next = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
  if (next instanceof HTMLElement) next.focus();
  else if (e.key === "ArrowUp") searchBox.focus();
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "k") && !e.altKey) {
    e.preventDefault();
    searchBox.focus();
    searchBox.select();
  }
});

// ---------- plugin pages ----------

/** Shows a plugin's page; from another page, leaving still goes back to where Settings was first. */
function openPage(id: string, params: PageParams = {}) {
  page = { id, params: { ...params }, back: page?.back ?? section };
  history.replaceState(null, "", `#${pageTarget(id, params)}`);
  content.scrollTop = 0;
  render();
}

/** Back from the page to where Settings was, at the plugin's card. */
function leavePage() {
  if (!page) return;
  section = page.back;
  if (section === "widgets") widget = page.id;
  else scrollToCard = page.id;
  page = null;
  history.replaceState(null, "", `#${here()}`);
  render();
}

function closeDrawnPage() {
  const stop = drawnPage?.stop;
  drawnPage = null;
  stop?.();
}

/**
 * The page: the whole window is the plugin's, drawn once per opening (it gives its own way back,
 * with `host.close()`). Until its plugin is loaded, or when there is none, a way back and why.
 */
function pageView(open: OpenPage): Node[] {
  const key = pageTarget(open.id, open.params);
  if (drawnPage?.key === key) return drawnPage.nodes;
  closeDrawnPage();
  const plugin = plugins.find((p) => p.id === open.id);
  const back = button(`‹ ${SECTIONS[open.back].label}`, leavePage, { class: "link page-back" });
  if (!plugin?.page) {
    // Plugins from the folder may still be loading: drawn again once they are.
    const why = !scanned ? "Loading…" : plugin ? `${plugin.label} has no page.` : "This plugin isn't turned on: see Plugins.";
    return [h("div", { class: "page-missing" }, back, ...header(plugin?.label ?? "Page", why))];
  }
  const root = h("div", { class: "plugin-page" });
  document.title = plugin.label;
  let stop: (() => void) | undefined;
  if (!inTauri) return [h("div", { class: "page-missing" }, back, ...header(plugin.label, "This page is available in the app."))];
  else {
    const host: PageHost<never> = {
      params: Object.freeze({ ...open.params }),
      options: () => resolve(plugin.options ?? {}, settings.options[plugin.id]) as never,
      setOptions: (patch) => commit({ ...settings, options: { ...settings.options, [plugin.id]: { ...settings.options[plugin.id], ...(patch as Readonly<Record<string, unknown>>) } } }),
      openPage: (params) => openPage(plugin.id, params),
      setTitle: (text) => void (document.title = String(text)),
      close: () => void (page?.id === plugin.id && leavePage()),
    };
    stop = plugin.page.call(plugin, root, services as never, host) ?? undefined;
  }
  drawnPage = { key, nodes: [root], stop };
  return drawnPage.nodes;
}

// ---------- the menu ----------

/** Where Settings is, as its address: "general", "widgets:dictation". */
const here = () => (section === "widgets" && widget ? `widgets:${widget}` : section);

function showSection(key: Section) {
  page = null;
  section = key;
  widget = null;
  clearSearch();
  history.replaceState(null, "", `#${key}`);
  content.scrollTop = 0;
  render();
}

function openWidget(id: string | null) {
  page = null;
  section = "widgets";
  widget = id;
  clearSearch();
  history.replaceState(null, "", `#${here()}`);
  content.scrollTop = 0;
  render();
}

function navItem(label: string, markup: string, current: boolean, go: () => void, attrs: Record<string, string>, extra: Node[] = []): HTMLButtonElement {
  return button(h("span", { class: "nav-in" }, icon(markup), h("span", { class: "nav-label" }, label), ...extra), go, {
    ...attrs,
    ...(current ? { "aria-current": "page" } : {}),
  });
}

function renderNav() {
  // Drawn again on every change: the item that had the focus gets it back, and the list keeps its place.
  const focused = document.activeElement instanceof HTMLElement && nav.contains(document.activeElement) ? document.activeElement : null;
  const key = focused ? `${focused.dataset.section ?? ""}:${focused.dataset.widget ?? ""}:${focused.textContent}` : null;
  const scroll = navList.scrollTop;
  fillNav();
  navList.scrollTop = scroll;
  if (key) [...nav.querySelectorAll<HTMLElement>("button")].find((b) => `${b.dataset.section ?? ""}:${b.dataset.widget ?? ""}:${b.textContent}` === key)?.focus();
}

function fillNav() {
  const at = (key: Section) => !page && !query && section === key && (key !== "widgets" || !plugins.some((p) => p.id === widget));
  const item = (key: Section) => navItem(SECTIONS[key].label, SECTIONS[key].icon, at(key), () => showSection(key), { "data-section": key });
  navList.replaceChildren(
    ...(["general", "appearance", "layout", "notifications", "shortcuts"] as const).map(item),
    h("div", { class: "nav-group" }, "Widgets"),
    navItem("All widgets", GRID, at("widgets"), () => openWidget(null), { "data-section": "widgets" }),
    ...plugins.map((p) =>
      navItem(p.label, p.icon || GRID, !page && !query && section === "widgets" && widget === p.id, () => openWidget(p.id), { "data-widget": p.id, class: "nav-sub" }, [
        setupDot(p.id, p.options ?? {}),
      ]),
    ),
    h("div", { class: "nav-group" }, "Integrations"),
    item("providers"),
    item("plugins"),
  );
  navFoot.replaceChildren(item("about"), status);
}

// ---------- drawing ----------

function render() {
  app.dataset.page = "false";
  renderNav();
  const scroll = content.scrollTop;
  for (const stop of panelStops) stop();
  panelStops = [];
  if (page && !query) {
    const nodes = pageView(page);
    // A plugin's page has the whole window: no menu, no margins.
    app.dataset.page = String(nodes[0] instanceof HTMLElement && nodes[0].classList.contains("plugin-page"));
    // Already on screen: left as it is, focus and typing included.
    if (content.firstChild !== nodes[0]) content.replaceChildren(...nodes);
    return;
  }
  closeDrawnPage();
  document.title = "AiN settings";
  const shown = query.trim() ? results() : RENDER[section]();
  content.replaceChildren(pageHead(shown), h("div", { class: "page-body" }, ...shown.body));
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
  if (scrollToField) {
    // A row by its label, else a card or a group by its title, else a heading.
    const named = (el: HTMLElement) => (el.matches(".subhead") ? el : el.querySelector(":scope > div > .field-label, :scope > .card-head h2, :scope > .group-title"))?.textContent?.trim();
    const row = [...content.querySelectorAll<HTMLElement>(".field, .card, .group, .subhead")].find((el) => named(el) === scrollToField);
    scrollToField = null;
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.classList.add("highlight");
    }
  }
}

/** Shows a place asked for from elsewhere, e.g. the island's "Set up in Settings", or a search result. */
function goTo(target: string) {
  const asked = parsePage(target);
  if (asked) return openPage(asked.id, asked.params);
  const place = parseTarget(target, Object.keys(SECTIONS));
  if (!place || !isSection(place.section)) return;
  page = null;
  section = place.section;
  widget = section === "widgets" ? place.card : null;
  scrollToCard = section === "widgets" ? null : place.card;
  history.replaceState(null, "", `#${here()}`);
  content.scrollTop = 0;
  render();
}

// ---------- problems ----------

onProblem(toasts.problem);
// What nothing else caught: still said, so a failure is never silent.
window.addEventListener("unhandledrejection", (e) => reportProblem("Something went wrong", e.reason, "UNEXPECTED"));
window.addEventListener("error", (e) => reportProblem("Something went wrong", e.error ?? e.message, "UNEXPECTED"));

// ---------- bootstrap ----------

document.body.append(app, toasts.el);
renderNav();

void popup.watchFailures((next) => {
  // Newly failing shortcuts are said once; the row stays marked until fixed.
  for (const [id, why] of Object.entries(next)) {
    if (failures[id] === why) continue;
    const e = entries().find((x) => x.id === id);
    reportProblem(`The shortcut for ${e ? e.command.label : id} doesn't work`, `${why}: pick another one in Shortcuts.`, "SHORTCUT_REGISTER");
  }
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
void loadPresets().then((next) => {
  presets = next;
  if (section === "providers") render();
});
void rescan().then(() => {
  scanned = true;
  render();
});
