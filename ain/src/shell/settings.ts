import { z } from "zod";
import { isHex } from "../sdk/color";
import { follow } from "../sdk/follow";
import type { PillSize } from "../sdk/style";
import { commands, events } from "./bindings/settings";
import type { Layout } from "./placement";
import { DEFAULT_NOTIFICATIONS, type NotificationSettings, parseNotifications } from "./notifications";
import { type AiProvider, parseProviders } from "./providers";

export interface General {
  /** Hover time before the island opens. */
  readonly openDelay: number;
  /** Grace time before it closes after the pointer leaves. */
  readonly closeDelay: number;
  /** Width of the folded pill at the Normal size, in px (a hardware notch sets its own). */
  readonly pillWidth: number;
  /** Low profile, normal or large: scales the pill and what it shows (a hardware notch keeps its size). */
  readonly pillSize: PillSize;
  /** The pill style's id: how the folded island looks (see sdk/style.ts). */
  readonly style: string;
  /** How round the pill's bottom corners are, in % of fully round. */
  readonly pillCurve: number;
  /** Built-in color theme (see shell/themes.ts); it gives the text and status colors. */
  readonly theme: string;
  /** Background of the pill and the open island, "#rrggbb"; the text color follows its lightness. */
  readonly pillColor: string;
  /** Buttons, progress bars and highlights, "#rrggbb". */
  readonly accentColor: string;
  /** The startup animation's id, or "none". */
  readonly greeting: string;
  /** How long the cursor must rest at the top center to show a hidden pill (the Hidden style). */
  readonly revealDelay: number;
  /** The screen the pill sits on, by id (see shell/screens.ts); null for the primary. While it's unplugged, the pill sits on the primary. */
  readonly screen: string | null;
  /** Trust any server certificate (self-signed, unknown CA): for closed networks only. */
  readonly acceptAnyCertificate: boolean;
  /** A folder or URL laid out like the models folder, to get models from without internet; "" for the internet. */
  readonly modelsSource: string;
}

/** How the collapsed pill dresses its glances (Settings → Pill). */
export interface PillLook {
  /** How many glances each end shows side by side, in priority order; 1 shows only the first with something to say. */
  readonly perSide: number;
  /** Plugins whose glance starts with their icon. */
  readonly icons: readonly string[];
  /** Plugins that show their icon, dimmed, while they have nothing to say. */
  readonly idle: readonly string[];
}

export interface Settings {
  readonly version: 1;
  readonly layout: Layout;
  readonly pill: PillLook;
  readonly general: General;
  /** Raw option values per plugin id; each plugin validates its own. */
  readonly options: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Shortcut per command id; null turns it off. Commands not listed use their default. */
  readonly shortcuts: Readonly<Record<string, string | null>>;
  /** Plugins the stored layout already knows about; any other plugin in the default layout is new, and gets added. */
  readonly seen: readonly string[];
  /**
   * Plugin files (relative to the plugins folder) the user turned on. Only these are ever run: a
   * plugin's id and details are only known by running it, so they are tracked by file.
   */
  readonly extensions: readonly string[];
  /** AI providers every AI feature may use instead of its model on this computer (see shell/providers.ts). */
  readonly providers: readonly AiProvider[];
  /** How notifications show, and which are kept quiet (see shell/notifications.ts). */
  readonly notifications: NotificationSettings;
}

/** Every plugin id the layout places. */
export const placed = (layout: Layout): string[] => [...new Set([...layout.glance.left, ...layout.glance.right, ...layout.tabs])];

/** Settings saved before `seen` existed knew these plugins. */
const FIRST_SEEN = ["clock", "timer", "clipboard", "stats", "media", "volume", "privacy", "screenshot"];

/**
 * Adds plugins that are new since the layout was saved, where the default layout puts them: a glance
 * spot at its default rank, a tab at the end. Plugins the user removed stay removed.
 */
export function adopt(layout: Layout, fallback: Layout, seen: readonly string[]): Layout {
  const fresh = new Set(placed(fallback).filter((id) => !seen.includes(id)));
  const merge = (mine: readonly string[], theirs: readonly string[], atRank: boolean) => {
    const out = mine.filter((id) => !fresh.has(id));
    theirs.forEach((id, rank) => {
      if (fresh.has(id)) out.splice(atRank ? Math.min(rank, out.length) : out.length, 0, id);
    });
    return out;
  };
  if (!fresh.size) return layout;
  return {
    glance: { left: merge(layout.glance.left, fallback.glance.left, true), right: merge(layout.glance.right, fallback.glance.right, true) },
    tabs: merge(layout.tabs, fallback.tabs, false),
  };
}

export const DEFAULT_GENERAL: General = { openDelay: 140, closeDelay: 260, pillWidth: 400, pillSize: "normal", style: "pill", pillCurve: 100, theme: "island", pillColor: "#000000", accentColor: "#0a84ff", greeting: "hello", revealDelay: 500, acceptAnyCertificate: false, modelsSource: "", screen: null };
export const PILL_SIZE_IDS = ["low", "normal", "large"] as const satisfies readonly PillSize[];
/** The style that keeps the pill hidden until the cursor rests on its spot. */
export const HIDDEN_STYLE = "hidden";
export const DELAY_RANGE = { min: 0, max: 1000, step: 20 } as const;
export const REVEAL_RANGE = { min: 100, max: 2000, step: 100 } as const;
export const WIDTH_RANGE = { min: 120, max: 480, step: 10 } as const;
export const CURVE_RANGE = { min: 0, max: 100, step: 5 } as const;
export const PER_SIDE_RANGE = { min: 1, max: 4, step: 1 } as const;
export const DEFAULT_PILL: PillLook = { perSide: 1, icons: [], idle: [] };

export const defaults = (layout: Layout): Settings => ({ version: 1, layout, pill: DEFAULT_PILL, general: DEFAULT_GENERAL, options: {}, shortcuts: {}, seen: placed(layout), extensions: [], providers: [], notifications: DEFAULT_NOTIFICATIONS });

const ids = z.array(z.string()).transform((list) => [...new Set(list)]);
const ID = /^[a-z][a-z0-9-]{1,31}$/;
const within = (range: { min: number; max: number }) => (fallback: number) => z.number().int().min(range.min).max(range.max).catch(fallback);
const delay = within(DELAY_RANGE);
const color = (fallback: string) =>
  z
    .string()
    .refine(isHex)
    .transform((c) => c.toLowerCase())
    .catch(fallback);

/** Settings saved before pill styles had `autoHide: true` for what is now the Hidden style. */
const legacyStyle = (raw: unknown): string | undefined => {
  const general = typeof raw === "object" && raw !== null ? (raw as { general?: unknown }).general : undefined;
  return typeof general === "object" && general !== null && (general as { autoHide?: unknown }).autoHide === true ? HIDDEN_STYLE : undefined;
};

/** Reads whatever is stored, keeping every valid part and filling the rest from `fallback`. */
export function parseSettings(raw: unknown, fallback: Settings): Settings {
  const { layout } = fallback;
  const schema = z.object({
    version: z.literal(1).catch(1),
    layout: z
      .object({ glance: z.object({ left: ids, right: ids }), tabs: ids })
      .catch(() => ({ glance: { left: [...layout.glance.left], right: [...layout.glance.right] }, tabs: [...layout.tabs] })),
    pill: z
      .object({ perSide: within(PER_SIDE_RANGE)(fallback.pill.perSide), icons: ids.catch([...fallback.pill.icons]), idle: ids.catch([...fallback.pill.idle]) })
      .catch(() => ({ perSide: fallback.pill.perSide, icons: [...fallback.pill.icons], idle: [...fallback.pill.idle] })),
    general: z
      .object({
        openDelay: delay(fallback.general.openDelay),
        closeDelay: delay(fallback.general.closeDelay),
        pillWidth: within(WIDTH_RANGE)(fallback.general.pillWidth),
        pillSize: z.enum(PILL_SIZE_IDS).catch(fallback.general.pillSize),
        style: z.string().regex(ID).catch(legacyStyle(raw) ?? fallback.general.style),
        pillCurve: within(CURVE_RANGE)(fallback.general.pillCurve),
        theme: z.string().min(1).catch(fallback.general.theme),
        pillColor: color(fallback.general.pillColor),
        accentColor: color(fallback.general.accentColor),
        greeting: z.string().regex(ID).catch(fallback.general.greeting),
        revealDelay: within(REVEAL_RANGE)(fallback.general.revealDelay),
        screen: z.string().min(1).max(256).nullable().catch(fallback.general.screen),
        acceptAnyCertificate: z.boolean().catch(fallback.general.acceptAnyCertificate),
        modelsSource: z.string().trim().catch(fallback.general.modelsSource),
      })
      .catch(fallback.general),
    options: z.record(z.string(), z.record(z.string(), z.unknown())).catch(fallback.options),
    shortcuts: z.record(z.string(), z.string().min(1).nullable()).catch(fallback.shortcuts),
    seen: ids.optional().catch(undefined),
    extensions: ids.catch([]),
    providers: z.array(z.unknown()).catch([]).transform(parseProviders),
    notifications: z.unknown().optional().transform((n) => parseNotifications(n, fallback.notifications)),
  });
  // Anything unreadable at the top level becomes `{}`, which every field above then defaults.
  const parsed = schema.safeParse(raw);
  const data = parsed.success ? parsed.data : schema.parse({});
  // No stored layout means the default one, which already has everything.
  const storedLayout = parsed.success && typeof raw === "object" && raw !== null && "layout" in raw;
  const seen = data.seen ?? (storedLayout ? FIRST_SEEN : placed(layout));
  return { ...data, layout: adopt(data.layout, layout, seen), seen: [...new Set([...seen, ...placed(layout)])] };
}

export interface SettingsPort {
  /** Calls `onChange` with the stored settings (raw, unvalidated) now and whenever they change. */
  watch(onChange: (raw: unknown) => void): Promise<() => void>;
  save(settings: Settings): Promise<void>;
  /** Opens the settings window, at `target` when given: a section, or "widgets:<plugin id>" for a widget's card. */
  open(target?: string): Promise<void>;
  /** Calls `onTarget` each time something asks the already-open settings window to show a place. */
  onNavigate(onTarget: (target: string) => void): Promise<() => void>;
  /** Quits the whole app: every window, the tray icon and everything running in the background. */
  quit(): Promise<void>;
  /** Asks the island to play the startup animation `id` now. */
  playGreeting(id: string): Promise<void>;
  /** Calls `onPlay` with the id of each startup animation the island is asked to play. */
  onPlayGreeting(onPlay: (id: string) => void): Promise<() => void>;
  /** Asks the island to show a sample notification, as the notification settings have it. */
  testNotification(): Promise<void>;
  /** Calls `onTest` each time a sample notification is asked for. */
  onTestNotification(onTest: () => void): Promise<() => void>;
  autostart(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
}

export const tauriSettings: SettingsPort = {
  watch: (onChange) => follow(events.settingsChanged, commands.get, onChange),
  save: async (value) => void (await commands.set(value)),
  open: async (target) => void (await commands.open(target ?? null)),
  onNavigate: (onTarget) => events.navigate.listen((e) => onTarget(e.payload)),
  quit: async () => void (await commands.quit()),
  playGreeting: async (id) => void (await commands.playGreeting(id)),
  onPlayGreeting: (onPlay) => events.playGreeting.listen((e) => onPlay(e.payload)),
  testNotification: async () => void (await commands.testNotification()),
  onTestNotification: (onTest) => events.testNotification.listen(() => onTest()),
  autostart: () => commands.autostart(),
  setAutostart: async (enabled) => void (await commands.setAutostart(enabled)),
};

/** In-memory settings, for the browser previews. */
export function memorySettings(): SettingsPort {
  let stored: unknown = null;
  let autostart = false;
  const listeners = new Set<(raw: unknown) => void>();
  const players = new Set<(id: string) => void>();
  const testers = new Set<() => void>();
  return {
    watch: async (onChange) => {
      listeners.add(onChange);
      onChange(stored);
      return () => listeners.delete(onChange);
    },
    save: async (value) => {
      stored = structuredClone(value);
      for (const l of listeners) l(stored);
    },
    open: async () => {},
    onNavigate: async () => () => {},
    quit: async () => {},
    playGreeting: async (id) => players.forEach((p) => p(id)),
    onPlayGreeting: async (onPlay) => {
      players.add(onPlay);
      return () => players.delete(onPlay);
    },
    testNotification: async () => testers.forEach((t) => t()),
    onTestNotification: async (onTest) => {
      testers.add(onTest);
      return () => testers.delete(onTest);
    },
    autostart: async () => autostart,
    setAutostart: async (enabled) => {
      autostart = enabled;
    },
  };
}

/** What placing needs to know about a plugin. */
interface Placeable {
  readonly id: string;
  readonly slots: readonly ("glance" | "tab")[];
}

/** The layout without `ids` anywhere. */
export const without = (layout: Layout, ids: ReadonlySet<string>): Layout => ({
  glance: { left: layout.glance.left.filter((id) => !ids.has(id)), right: layout.glance.right.filter((id) => !ids.has(id)) },
  tabs: layout.tabs.filter((id) => !ids.has(id)),
});

/** Places a newly turned-on plugin where it fits (a tab at the end, else last on the right), unless it is placed already. */
export function placeNew(settings: Settings, plugin: Placeable): Settings {
  const { layout } = settings;
  if (placed(layout).includes(plugin.id)) return settings;
  const next: Layout = plugin.slots.includes("tab")
    ? { ...layout, tabs: [...layout.tabs, plugin.id] }
    : { ...layout, glance: { ...layout.glance, right: [...layout.glance.right, plugin.id] } };
  return { ...settings, layout: next };
}

/** Turns a plugin file on or off; turned off, its plugin (when known) also leaves the layout. */
export function setExtension(settings: Settings, file: string, on: boolean, plugin?: Placeable): Settings {
  const others = settings.extensions.filter((f) => f !== file);
  if (on) return { ...settings, extensions: [...others, file] };
  const layout = plugin ? without(settings.layout, new Set([plugin.id])) : settings.layout;
  return { ...settings, extensions: others, layout };
}

/** The layout the island runs: plugins loaded from files since turned off stay out, whatever the file says. */
export const runnable = (settings: Settings, loaded: readonly { readonly file: string; readonly id: string }[]): Layout =>
  without(settings.layout, new Set(loaded.filter((l) => !settings.extensions.includes(l.file)).map((l) => l.id)));

/**
 * Where a settings target points: "widgets:dictation" is the Widgets section, at the dictation
 * card. Null for a section that doesn't exist.
 */
export function parseTarget(target: string, sections: readonly string[]): { section: string; card: string | null } | null {
  const [section = "", card = ""] = target.split(":", 2);
  return sections.includes(section) ? { section, card: card || null } : null;
}

/** The settings target of a plugin's page: "page:google-calendar?event=abc" (`params` URL-encoded). */
export function pageTarget(pluginId: string, params: Readonly<Record<string, string>> = {}): string {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => typeof v === "string")).toString();
  return query ? `page:${pluginId}?${query}` : `page:${pluginId}`;
}

/** The plugin and params a page target opens; null when it isn't one. */
export function parsePage(target: string): { id: string; params: Record<string, string> } | null {
  const match = /^page:([a-z][a-z0-9-]{1,31})(?:\?(.*))?$/.exec(target);
  if (!match?.[1]) return null;
  return { id: match[1], params: Object.fromEntries(new URLSearchParams(match[2] ?? "")) };
}
