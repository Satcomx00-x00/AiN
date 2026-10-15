import type { Fields, Values } from "./options";

export type Tone = "alert" | "muted";

/** A small indicator drawn before a glance's text. */
export type Mark = "mic" | "camera" | "eq" | "rec";

/** A plugin's short status for a glance spot on the collapsed pill. */
export interface Glance {
  readonly text: string;
  /** 0–1, drawn as a mini ring. */
  readonly progress?: number;
  /** Recent values in 0–100, drawn as a mini sparkline. */
  readonly spark?: readonly number[];
  /** 0–1, drawn as a slim level bar. */
  readonly level?: number;
  /** A small image drawn first, e.g. album art. */
  readonly art?: string;
  readonly mark?: Mark;
  readonly tone?: Tone;
  /** Widens the collapsed pill while shown, like a live activity. */
  readonly wide?: boolean;
}

export interface TickContext {
  readonly now: number;
  /** True while this plugin's tab is on screen. */
  readonly visible: boolean;
}

/**
 * What a plugin contributes once set up. Every part is optional;
 * the layout decides where (and whether) each part is shown.
 */
export interface Widget {
  /** Builds the content of this plugin's tab, once. */
  readonly panel?: (root: HTMLElement) => void;
  /** Status for a glance spot, or null when there is nothing to say. */
  readonly glance?: (now: number) => Glance | null;
  /** Runs once per second while the plugin is loaded. */
  readonly tick?: (ctx: TickContext) => void | Promise<void>;
  /** A color that tints the island while this plugin is in focus, or null for the default. */
  readonly ambient?: () => string | null;
}

/** What the host offers plugins. */
export interface Host<Options = unknown> {
  /** Redraws glances and the visible panel now, e.g. after pushed data arrives. */
  refresh(): void;
  /** This plugin's current option values; read them when needed, since the user can change them anytime. */
  options(): Options;
  /** Saves some of this plugin's options (e.g. a choice made in its panel); settings and other windows follow. */
  setOptions(patch: Partial<Options>): void;
}

export type Surface = "popup" | "screen" | "action";

/** What a command's popup can do. */
export interface PopupContext<Services, Options> {
  readonly services: Services;
  /** The plugin's current option values. */
  options(): Options;
  /** Hides the popup. */
  close(): void;
  /** Hides the popup and pastes the clipboard into the app the user was in. */
  paste(): Promise<void>;
}

export interface PopupView {
  /** Called each time the popup appears for this command: refresh data and take focus. */
  show(): void;
}

/**
 * Something a plugin can do on a global shortcut, in a small popup (the island as a multi-tool).
 * Its full id is `<plugin id>.<command id>`.
 */
export interface Command<Services = unknown, Options = unknown> {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Default shortcut, e.g. "Super+Shift+KeyB" (key names follow `KeyboardEvent.code`); null for none. */
  readonly shortcut: string | null;
  /**
   * Where it shows: the small launcher `popup` (default), or `screen`, a full-screen window over a
   * capture of the monitor under the pointer, taken just before it appears; or `action`, no window
   * at all: the plugin's backend acts on the key press (and release, for "hold to talk").
   */
  readonly surface?: Surface;
  /** Builds the popup's content once; `show` runs on every appearance. Not used by `action` commands. */
  popup?(root: HTMLElement, ctx: PopupContext<Services, Options>): PopupView;
}

/** Where a plugin can be placed: a glance spot on the collapsed pill, or a tab. */
export type Slot = "glance" | "tab";

/**
 * A self-contained feature. `Services` lists only the backend ports it needs,
 * so a plugin can be tested or previewed with fakes of just those.
 */
export interface Plugin<Services = unknown, F extends Fields = Fields> {
  readonly id: string;
  readonly label: string;
  /** One line for the settings page. */
  readonly description: string;
  /** Inner SVG markup for a 16×16 stroke icon. */
  readonly icon: string;
  /** Where the settings page lets the user put it; must match what `setup` returns. */
  readonly slots: readonly Slot[];
  /** User-configurable options; the settings page draws controls for them. */
  readonly options?: F;
  /** Actions on global shortcuts, each with its own popup. Built-in features only. */
  readonly commands?: readonly Command<Services, Values<F>>[];
  /**
   * For plugins from the plugins folder: the services `setup` receives (e.g. `["media"]`); it gets
   * no others. Built-in features type the services they use instead.
   */
  readonly needs?: readonly string[];
  setup(services: Services, host: Host<Values<F>>): Widget;
}

export const definePlugin = <Services = unknown, F extends Fields = Record<never, never>>(plugin: Plugin<Services, F>): Plugin<Services, F> => plugin;

/** Any plugin, when only its metadata matters. */
export type AnyPlugin = Plugin<never, Fields>;

/** A plugin that has been set up, as the host and placement see it. */
export interface Mounted {
  readonly plugin: AnyPlugin;
  readonly widget: Widget;
}
