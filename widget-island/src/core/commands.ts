import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { follow } from "./live";
import type { AnyPlugin, Command, Surface } from "./plugin";

/** A command with the plugin it belongs to and its full id (`<plugin>.<command>`). */
export interface Entry {
  readonly id: string;
  readonly plugin: AnyPlugin;
  readonly command: Command<never, never>;
}

export const commandsOf = (catalogue: readonly AnyPlugin[]): Entry[] =>
  catalogue.flatMap((plugin) => (plugin.commands ?? []).map((command) => ({ id: `${plugin.id}.${command.id}`, plugin, command })));

/** The shortcut in effect: the user's choice if they made one (null = turned off), else the default. */
export const shortcutOf = (entry: Entry, chosen: Readonly<Record<string, string | null>>): string | null =>
  entry.id in chosen ? (chosen[entry.id] ?? null) : entry.command.shortcut;

export const surfaceOf = (entry: Entry): Surface => entry.command.surface ?? "popup";

export interface Binding {
  readonly shortcut: string;
  readonly surface: Surface;
}

/** Command id → shortcut and surface, for every command that has a shortcut. */
export const bindings = (catalogue: readonly AnyPlugin[], chosen: Readonly<Record<string, string | null>>): Record<string, Binding> =>
  Object.fromEntries(
    commandsOf(catalogue).flatMap((e) => {
      const shortcut = shortcutOf(e, chosen);
      return shortcut ? [[e.id, { shortcut, surface: surfaceOf(e) }]] : [];
    }),
  );

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Super"] as const;
const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/** A shortcut from a key press, or null while only modifiers are held or none is held (F-keys excepted). */
export function fromKey(e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code">): string | null {
  if (!e.code || MODIFIER_CODES.test(e.code)) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter((m): m is (typeof MODIFIERS)[number] => !!m);
  if (!mods.length && !/^F\d{1,2}$/.test(e.code)) return null;
  return [...mods, e.code].join("+");
}

const KEY_LABELS: Record<string, string> = { Super: "Win", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Backquote: "`", Space: "Space" };

/** "Super+Shift+KeyB" → ["Win", "Shift", "B"], for display as keycaps. */
export const keycaps = (shortcut: string): string[] =>
  shortcut.split("+").map((part) => KEY_LABELS[part] ?? part.replace(/^Key|^Digit|^Arrow/, ""));

export interface PopupPort {
  /** Registers shortcuts (command id → shortcut and surface); resolves with the ones that failed and why. */
  bind(bindings: Record<string, Binding>): Promise<Record<string, string>>;
  /** Calls `onChange` with failed shortcuts now and after every re-bind. */
  watchFailures(onChange: (failures: Record<string, string>) => void): Promise<() => void>;
  open(command: string, surface: Surface): Promise<void>;
  /** Hides the window that asks: the popup or the capture overlay. */
  hide(): Promise<void>;
  paste(): Promise<void>;
  /** Calls `onShow` with the command id each time the popup is shown. */
  onShow(onShow: (command: string) => void): Promise<() => void>;
}

const Failures = z.record(z.string(), z.string());

export const tauriPopup: PopupPort = {
  bind: async (map) => Failures.parse(await invoke("plugin:popup|bind", { bindings: map })),
  watchFailures: (onChange) => follow("popup:bindings", "plugin:popup|failures", Failures, onChange),
  open: (command, surface) => invoke("plugin:popup|open", { command, surface }),
  hide: () => invoke("plugin:popup|hide"),
  paste: () => invoke("plugin:popup|paste"),
  onShow: (onShow) => listen<unknown>("popup:show", (e) => onShow(z.object({ command: z.string() }).parse(e.payload).command)),
};

/** No shortcuts and no popup, for the browser previews. */
export const idlePopup: PopupPort = {
  bind: async () => ({}),
  watchFailures: async (onChange) => (onChange({}), () => {}),
  open: async () => {},
  hide: async () => {},
  paste: async () => {},
  onShow: async () => () => {},
};
