import type { AnyNotice, HookResult, Notification, NotificationHandle } from "./notify";
import type { Fields, Values } from "./options";
import type { PillSize } from "./style";

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
  /**
   * Sees each notification from another source before it shows; returns it (changed or not),
   * "silent" or null (see `HookResult`). Only for plugins that list `notifications` in `needs`.
   */
  readonly onNotification?: (n: Notification) => HookResult;
  /** One of this plugin's notifications had action `actionId` pressed. */
  readonly onNotificationAction?: (notificationId: string, actionId: string) => void;
  /** One of this plugin's `commands` was triggered by its shortcut: pressed, released, or tapped (Try it). */
  readonly onCommand?: (commandId: string, kind: CommandKind) => void;
}

/** How the island looks right now, for plugins that adapt to it. */
export interface Appearance {
  /** The pill style drawing the folded island: "pill", "solo", "stub", "sliver", "hidden" or a plugin's id. */
  readonly style: string;
  /** The pill size picked in Settings → Appearance. */
  readonly size: PillSize;
  /** The color theme's id, e.g. "dracula"; the colors themselves are the island's CSS variables. */
  readonly theme: string;
  /** Whether the pill is light or dark, after the user's own pill color. */
  readonly tone: "light" | "dark";
  /** True when a hardware notch sets the pill's height. */
  readonly notch: boolean;
}

/** What a plugin's page is opened with, e.g. which record to edit: short strings, by name. */
export type PageParams = Readonly<Record<string, string>>;

/** What the host offers plugins. */
export interface Host<Options = unknown> {
  /** Redraws glances and the visible panel now, e.g. after pushed data arrives. */
  refresh(): void;
  /** This plugin's current option values; read them when needed, since the user can change them anytime. */
  options(): Options;
  /** Saves some of this plugin's options (e.g. a choice made in its panel); settings and other windows follow. */
  setOptions(patch: Partial<Options>): void;
  /**
   * One of its `secret` options (an API key, a token), from the system's credential store; "" when
   * none is saved. Read it when needed, since the user can change it anytime.
   */
  secret(key: keyof Options & string): Promise<string>;
  /** Opens Settings at this plugin's card: where to set it up, rather than in the island. */
  openSettings(): void;
  /** Opens this plugin's `page` in the Settings window, with `params`: where to type, since the island takes no keys. */
  openPage(params?: PageParams): void;
  /** How the island looks now; read it when drawing, since the user can change it anytime. */
  appearance(): Appearance;
  /**
   * Posts a notification, shown the way the user chose, unless they turned this plugin's notifications
   * off. Takes AiN's own notice, or one in freedesktop's, the W3C's or a Windows toast's format.
   */
  notify(notice: AnyNotice): NotificationHandle;
  /** Calls `listener` on each `event`; returns how to stop. */
  on<E extends keyof HostEvents>(event: E, listener: (payload: HostEvents[E]) => void): () => void;
}

/**
 * What happens on the island, for `host.on`. The services a plugin needs have their own `watch`
 * (now playing, volume, mic and camera…).
 */
export interface HostEvents {
  /** The island opened (true) or folded (false). */
  readonly open: boolean;
  /** The pill's look changed (style, size, theme, colors). */
  readonly appearance: Appearance;
  /** This plugin's options changed, e.g. in Settings. */
  readonly options: unknown;
  /** The count of notifications the user hasn't seen changed. */
  readonly unseen: number;
}

/** How a command's shortcut fired. */
export type CommandKind = "press" | "release" | "tap";

/** What a plugin's settings panel can do with its options. */
export interface SettingsHost<Options = unknown> {
  /** The current option values. */
  options(): Options;
  /** Saves some of them, as the standard controls do. */
  setOptions(patch: Partial<Options>): void;
  /** Opens this plugin's `page`, with `params`. */
  openPage(params?: PageParams): void;
}

/** What a plugin's page can do: its options, what it was opened with, its title, and leaving. */
export interface PageHost<Options = unknown> extends SettingsHost<Options> {
  /** What it was opened with ({} when nothing). */
  readonly params: PageParams;
  /** The page's heading, e.g. "Edit event"; the plugin's name until set. */
  setTitle(title: string): void;
  /** Leaves the page, back to where Settings was before it. */
  close(): void;
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
   * at all: the plugin's backend acts on the key press (and release, for "hold to talk"), and
   * its widget's `onCommand` hears it. Plugins from the plugins folder only have `action`.
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
  /** Actions on global shortcuts: built-in features may open a popup; plugins from the plugins folder get `onCommand`. */
  readonly commands?: readonly Command<Services, Values<F>>[];
  /**
   * For plugins from the plugins folder: the services `setup` receives (e.g. `["media"]`); it gets
   * no others. Built-in features type the services they use instead.
   */
  readonly needs?: readonly string[];
  /**
   * How tall the open panel is while its tab is shown, in px: the island grows to it (up to 340),
   * for a tab that needs room, like a calendar's month. Left out, it gets the usual 156.
   */
  readonly panelHeight?: number;
  /**
   * Extra controls for this plugin's card in Settings → Widgets, under its options: for setup an
   * option can't express, like downloading a model, and for options marked `inPanel`. Gets the
   * same services as `setup`. Returns a function that stops whatever it watches; it is called
   * when the card is redrawn or closed.
   */
  settingsPanel?(root: HTMLElement, services: Services, host: SettingsHost<Values<F>>): (() => void) | void;
  /**
   * A page of its own in the Settings window, for work that needs room and typing, like editing a
   * record: opened with `host.openPage(params)` from its tab or its settings panel. Gets the same
   * services as `setup`. Returns a function that stops whatever it watches; it is called when the
   * page is left.
   */
  page?(root: HTMLElement, services: Services, host: PageHost<Values<F>>): (() => void) | void;
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
