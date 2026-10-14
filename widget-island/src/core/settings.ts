import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { follow } from "./live";
import type { Layout } from "./placement";

export interface General {
  /** Hover time before the island opens. */
  readonly openDelay: number;
  /** Grace time before it closes after the pointer leaves. */
  readonly closeDelay: number;
}

export interface Settings {
  readonly version: 1;
  readonly layout: Layout;
  readonly general: General;
  /** Raw option values per plugin id; each plugin validates its own. */
  readonly options: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Shortcut per command id; null turns it off. Commands not listed use their default. */
  readonly shortcuts: Readonly<Record<string, string | null>>;
}

export const DEFAULT_GENERAL: General = { openDelay: 140, closeDelay: 260 };
export const DELAY_RANGE = { min: 0, max: 1000, step: 20 } as const;

export const defaults = (layout: Layout): Settings => ({ version: 1, layout, general: DEFAULT_GENERAL, options: {}, shortcuts: {} });

const ids = z.array(z.string()).transform((list) => [...new Set(list)]);
const delay = (fallback: number) => z.number().int().min(DELAY_RANGE.min).max(DELAY_RANGE.max).catch(fallback);

/** Reads whatever is stored, keeping every valid part and filling the rest from `fallback`. */
export function parseSettings(raw: unknown, fallback: Settings): Settings {
  const { layout } = fallback;
  const schema = z.object({
    version: z.literal(1).catch(1),
    layout: z
      .object({ glance: z.object({ left: ids, right: ids }), tabs: ids })
      .catch(() => ({ glance: { left: [...layout.glance.left], right: [...layout.glance.right] }, tabs: [...layout.tabs] })),
    general: z
      .object({ openDelay: delay(fallback.general.openDelay), closeDelay: delay(fallback.general.closeDelay) })
      .catch(fallback.general),
    options: z.record(z.string(), z.record(z.string(), z.unknown())).catch(fallback.options),
    shortcuts: z.record(z.string(), z.string().min(1).nullable()).catch(fallback.shortcuts),
  });
  // Anything unreadable at the top level becomes `{}`, which every field above then defaults.
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : schema.parse({});
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
  watch: (onChange) => follow("settings:changed", "plugin:settings|get", z.unknown(), onChange),
  save: (value) => invoke("plugin:settings|set", { value }),
  open: () => invoke("plugin:settings|open"),
  autostart: async () => z.boolean().parse(await invoke("plugin:settings|autostart")),
  setAutostart: (enabled) => invoke("plugin:settings|set_autostart", { enabled }),
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
