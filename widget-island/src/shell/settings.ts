import { z } from "zod";
import { isHex } from "../sdk/color";
import { follow } from "../sdk/follow";
import { commands, events } from "./bindings/settings";
import type { Layout } from "./placement";

export interface General {
  /** Hover time before the island opens. */
  readonly openDelay: number;
  /** Grace time before it closes after the pointer leaves. */
  readonly closeDelay: number;
  /** Width of the folded pill, in px (a hardware notch sets its own). */
  readonly pillWidth: number;
  /** How round the pill's bottom corners are, in % of fully round. */
  readonly pillCurve: number;
  /** Built-in color theme (see shell/themes.ts); it gives the text and status colors. */
  readonly theme: string;
  /** Background of the pill and the open island, "#rrggbb"; the text color follows its lightness. */
  readonly pillColor: string;
  /** Buttons, progress bars and highlights, "#rrggbb". */
  readonly accentColor: string;
}

export interface Settings {
  readonly version: 1;
  readonly layout: Layout;
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

export const DEFAULT_GENERAL: General = { openDelay: 140, closeDelay: 260, pillWidth: 200, pillCurve: 100, theme: "island", pillColor: "#000000", accentColor: "#0a84ff" };
export const DELAY_RANGE = { min: 0, max: 1000, step: 20 } as const;
export const WIDTH_RANGE = { min: 120, max: 480, step: 10 } as const;
export const CURVE_RANGE = { min: 0, max: 100, step: 5 } as const;

export const defaults = (layout: Layout): Settings => ({ version: 1, layout, general: DEFAULT_GENERAL, options: {}, shortcuts: {}, seen: placed(layout), extensions: [] });

const ids = z.array(z.string()).transform((list) => [...new Set(list)]);
const within = (range: { min: number; max: number }) => (fallback: number) => z.number().int().min(range.min).max(range.max).catch(fallback);
const delay = within(DELAY_RANGE);
const color = (fallback: string) =>
  z
    .string()
    .refine(isHex)
    .transform((c) => c.toLowerCase())
    .catch(fallback);

/** Reads whatever is stored, keeping every valid part and filling the rest from `fallback`. */
export function parseSettings(raw: unknown, fallback: Settings): Settings {
  const { layout } = fallback;
  const schema = z.object({
    version: z.literal(1).catch(1),
    layout: z
      .object({ glance: z.object({ left: ids, right: ids }), tabs: ids })
      .catch(() => ({ glance: { left: [...layout.glance.left], right: [...layout.glance.right] }, tabs: [...layout.tabs] })),
    general: z
      .object({
        openDelay: delay(fallback.general.openDelay),
        closeDelay: delay(fallback.general.closeDelay),
        pillWidth: within(WIDTH_RANGE)(fallback.general.pillWidth),
        pillCurve: within(CURVE_RANGE)(fallback.general.pillCurve),
        theme: z.string().min(1).catch(fallback.general.theme),
        pillColor: color(fallback.general.pillColor),
        accentColor: color(fallback.general.accentColor),
      })
      .catch(fallback.general),
    options: z.record(z.string(), z.record(z.string(), z.unknown())).catch(fallback.options),
    shortcuts: z.record(z.string(), z.string().min(1).nullable()).catch(fallback.shortcuts),
    seen: ids.optional().catch(undefined),
    extensions: ids.catch([]),
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
  /** Opens the settings window. */
  open(): Promise<void>;
  autostart(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
}

export const tauriSettings: SettingsPort = {
  watch: (onChange) => follow(events.settingsChanged, commands.get, onChange),
  save: async (value) => void (await commands.set(value)),
  open: async () => void (await commands.open()),
  autostart: () => commands.autostart(),
  setAutostart: async (enabled) => void (await commands.setAutostart(enabled)),
};

/** In-memory settings, for the browser previews. */
export function memorySettings(): SettingsPort {
  let stored: unknown = null;
  let autostart = false;
  const listeners = new Set<(raw: unknown) => void>();
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
