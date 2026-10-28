/**
 * Third-party plugins: ES modules from the app's plugins folder. Each default-exports a function
 * that receives the SDK and returns a plugin definition (or a startup animation, or a pill style),
 * which is checked before use. A plugin
 * gets only the services it declares in `needs` (from those the app offers), and its widget is
 * isolated: if one of its parts throws, that part is switched off rather than breaking the island.
 *
 * Plugins run in the island's page with its permissions; they are only loaded once the user
 * enables them in Settings.
 */
import { type Sdk, sdk } from "../sdk";
import { reportProblem } from "../sdk/report";
import type { Greeting, Stage } from "../sdk/greeting";
import { isHex } from "../sdk/color";
import { type Field, type Fields, patternOf } from "../sdk/options";
import type { Notifier } from "../sdk/notify";
import type { AnyPlugin, Host, Widget } from "../sdk/plugin";
import type { AnyStyle } from "../sdk/style";
import { type Found, commands } from "./bindings/extensions";

export interface Extension {
  /** Where it came from, relative to the plugins folder. */
  readonly file: string;
  /** The plugin, when it loaded and passed every check. */
  readonly plugin: AnyPlugin | null;
  /** Or the startup animation, for a file that defines one instead. */
  readonly greeting: Greeting | null;
  /** Or the pill style, for a file that defines one instead. */
  readonly style: AnyStyle | null;
  /** Or the way to show notifications, for a file that defines one instead. */
  readonly notifier: Notifier | null;
  /** Services it asked for. */
  readonly needs: readonly string[];
  /** Why it can't be used, when it can't. */
  readonly problem: string | null;
}

/** The id a loaded file claims, if any. */
export const idOf = (ext: Extension): string | null => ext.plugin?.id ?? ext.greeting?.id ?? ext.style?.id ?? ext.notifier?.id ?? null;

export interface Rules {
  /** Ids already in use (the built-in features, startup animations and pill styles). */
  readonly taken: ReadonlySet<string>;
  /** Services a plugin may ask for. */
  readonly services: readonly string[];
}

/** Loads a module from its source text. */
export type Importer = (source: string) => Promise<unknown>;

export const importSource: Importer = async (source) => {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
};

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const SLOTS = new Set(["glance", "tab"]);
const KINDS: Record<Field["kind"], (v: unknown) => boolean> = {
  toggle: (v) => typeof v === "boolean",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  choice: (v) => typeof v === "string",
  list: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  folder: (v) => typeof v === "string",
  text: (v) => typeof v === "string",
  secret: (v) => v === "",
  color: isHex,
};

/** A secret's key names its entry in the credential store: the backend takes only these. */
const SECRET_KEY = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why a text or secret field's rules can't be checked, or null. */
function rulesProblem(key: string, field: Record<string, unknown>): string | null {
  if (field.required !== undefined && typeof field.required !== "boolean") return `option "${key}" has a required that isn't true or false`;
  if (field.maxLength !== undefined && !(Number.isInteger(field.maxLength) && (field.maxLength as number) > 0))
    return `option "${key}" needs a maxLength above 0`;
  if (field.pattern !== undefined && (typeof field.pattern !== "string" || !patternOf({ pattern: field.pattern })))
    return `option "${key}" has a pattern that isn't a valid regular expression`;
  return null;
}

/** Why `options` can't drive the settings page, or null when every field is well-formed. */
export function optionsProblem(options: unknown): string | null {
  if (options === undefined) return null;
  if (!isObject(options)) return "options must be an object of fields";
  for (const [key, field] of Object.entries(options)) {
    if (!isObject(field) || typeof field.label !== "string") return `option "${key}" needs a label`;
    const valid = KINDS[field.kind as Field["kind"]];
    if (!valid) return `option "${key}" has an unknown kind`;
    if (!valid(field.default)) return `option "${key}" has a default that doesn't fit its kind`;
    if (field.kind === "number" && ![field.min, field.max, field.step].every((n) => typeof n === "number" && Number.isFinite(n)))
      return `option "${key}" needs a min, max and step`;
    if (field.kind === "choice" && !(Array.isArray(field.choices) && field.choices.some((c) => isObject(c) && c.value === field.default)))
      return `option "${key}" needs choices that include its default`;
    if (field.kind === "secret" && !SECRET_KEY.test(key)) return `secret "${key}" needs a key of letters, digits, _ or -`;
    const rules = field.kind === "text" || field.kind === "secret" ? rulesProblem(key, field) : null;
    if (rules) return rules;
  }
  return null;
}

/**
 * The options a store entry declares, with the defaults a plugin's code would get from the SDK's
 * builders (a number's step, a secret's empty default); or why they can't be drawn.
 */
export function storeFields(declared: unknown): Fields | string | null {
  if (declared === null || declared === undefined) return null;
  if (!isObject(declared)) return "options must be an object of fields";
  const filled = Object.fromEntries(
    Object.entries(declared).map(([key, f]) => [
      key,
      !isObject(f) ? f : f.kind === "number" ? { step: 1, ...f } : f.kind === "secret" ? { ...f, default: "" } : f.kind === "color" && typeof f.default === "string" ? { ...f, default: f.default.toLowerCase() } : f,
    ]),
  );
  return optionsProblem(filled) ?? (filled as Fields);
}

/** Checks a definition; returns the problem, or the plugin with what it needs. */
export function check(def: unknown, rules: Rules): { plugin: AnyPlugin; needs: string[] } | string {
  if (!isObject(def)) return "the default export must return a plugin definition";
  const { id, label, description, icon, slots, setup, commands: cmds, needs = [] } = def;
  if (typeof id !== "string" || !ID.test(id)) return "id must be 2–32 lowercase letters, digits or dashes, starting with a letter";
  if (rules.taken.has(id)) return `the id "${id}" is already used`;
  if (typeof label !== "string" || !label.trim() || label.length > 40) return "label must be 1–40 characters";
  if (typeof description !== "string") return "description must be a string";
  if (typeof icon !== "string") return "icon must be SVG markup (a string)";
  if (!Array.isArray(slots) || !slots.length || !slots.every((s) => SLOTS.has(s))) return 'slots must list "glance" and/or "tab"';
  if (typeof setup !== "function") return "setup must be a function";
  if (def.settingsPanel !== undefined && typeof def.settingsPanel !== "function") return "settingsPanel must be a function";
  if (def.page !== undefined && typeof def.page !== "function") return "page must be a function";
  if (def.panelHeight !== undefined && !(typeof def.panelHeight === "number" && Number.isFinite(def.panelHeight) && def.panelHeight > 0))
    return "panelHeight must be a height in pixels";
  const commandProblem = commandsProblem(cmds);
  if (commandProblem) return commandProblem;
  if (!Array.isArray(needs) || !needs.every((n) => typeof n === "string")) return "needs must list service names";
  const unknown = needs.filter((n: string) => !rules.services.includes(n));
  if (unknown.length) return `unknown services: ${unknown.join(", ")} (available: ${rules.services.join(", ")})`;
  const problem = optionsProblem(def.options);
  if (problem) return problem;
  // Their commands have no popup: the shortcut goes to the widget's onCommand.
  const plugin = (Array.isArray(cmds) && cmds.length ? { ...def, commands: cmds.map((c: Record<string, unknown>) => ({ ...c, surface: "action" })) } : def) as unknown as AnyPlugin;
  return { plugin, needs: [...new Set(needs as string[])] };
}

const COMMAND_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Why a plugin file's shortcut commands can't be used, or null. They have no window of their own:
 * the widget's `onCommand` hears them (surface "action").
 */
function commandsProblem(cmds: unknown): string | null {
  if (cmds === undefined) return null;
  if (!Array.isArray(cmds) || cmds.length > 8) return "commands must list at most 8 commands";
  const ids = new Set<string>();
  for (const c of cmds) {
    if (!isObject(c)) return "each command must be an object";
    if (typeof c.id !== "string" || !COMMAND_ID.test(c.id) || ids.has(c.id)) return "each command needs its own id: 1–32 lowercase letters, digits or dashes";
    ids.add(c.id);
    if (typeof c.label !== "string" || !c.label.trim() || c.label.length > 40) return `command "${c.id}": label must be 1–40 characters`;
    if (typeof c.description !== "string") return `command "${c.id}": description must be a string`;
    if (c.shortcut !== null && (typeof c.shortcut !== "string" || !/^((Ctrl|Alt|Shift|Super)\+)*\w+$/.test(c.shortcut))) return `command "${c.id}": shortcut must look like "Ctrl+Alt+KeyN", or be null`;
    if (c.surface !== undefined && c.surface !== "action") return `command "${c.id}": plugins from the plugins folder only have surface "action" (their widget's onCommand hears it)`;
    if (c.popup !== undefined) return `command "${c.id}": popups are only available to built-in features`;
  }
  return null;
}

/** Checks a notifier's definition; returns the problem, or the notifier. */
export function checkNotifier(def: Record<string, unknown>, taken: ReadonlySet<string>): Notifier | string {
  const { id, label, description, show } = def;
  if (typeof id !== "string" || !ID.test(id)) return "id must be 2–32 lowercase letters, digits or dashes, starting with a letter";
  if (taken.has(id)) return `the id "${id}" is already used`;
  if (["pill", "bubble", "toast"].includes(id)) return `the id "${id}" is a built-in way to show notifications`;
  if (typeof label !== "string" || !label.trim() || label.length > 40) return "label must be 1–40 characters";
  if (description !== undefined && typeof description !== "string") return "description must be a string";
  if (typeof show !== "function") return "show must be a function";
  return { id, label, show: show as Notifier["show"], ...(description !== undefined && { description }) };
}

/** The notifier as the island runs it: a failure is reported, and that notification simply doesn't show. */
export function confineNotifier(notifier: Notifier, log: (message: string) => void = console.error): Notifier {
  return {
    ...notifier,
    show(stage, n, ctx) {
      try {
        const stop = notifier.show.call(notifier, stage, n, ctx);
        return typeof stop === "function" ? fuse(`notifier "${notifier.id}" cleanup`, stop, undefined, (what, e) => log(`[island] ${what} failed: ${String(e)}`)) : undefined;
      } catch (e) {
        log(`[island] notifier "${notifier.id}" failed: ${String(e)}`);
        return undefined;
      }
    },
  };
}

/** Checks a startup animation's definition; returns the problem, or the animation. */
export function checkGreeting(def: Record<string, unknown>, taken: ReadonlySet<string>): Greeting | string {
  const { id, label, play } = def;
  if (typeof id !== "string" || !ID.test(id)) return "id must be 2–32 lowercase letters, digits or dashes, starting with a letter";
  if (taken.has(id)) return `the id "${id}" is already used`;
  if (typeof label !== "string" || !label.trim() || label.length > 40) return "label must be 1–40 characters";
  if (typeof play !== "function") return "play must be a function";
  return { id, label, play: play as Greeting["play"] };
}

/** The animation as the island plays it: a failure is reported, and the island carries on. */
export function confineGreeting(greeting: Greeting, log: (message: string) => void = console.error): Greeting {
  return {
    id: greeting.id,
    label: greeting.label,
    async play(stage: Stage) {
      try {
        await greeting.play(stage);
      } catch (e) {
        log(`[island] startup animation "${greeting.id}" failed: ${String(e)}`);
      }
    },
  };
}

/** Checks a pill style's definition; returns the problem, or the style. */
export function checkStyle(def: Record<string, unknown>, taken: ReadonlySet<string>): AnyStyle | string {
  const { id, label, description, widens, mount, size, hidden } = def;
  if (typeof id !== "string" || !ID.test(id)) return "id must be 2–32 lowercase letters, digits or dashes, starting with a letter";
  if (taken.has(id)) return `the id "${id}" is already used`;
  if (typeof label !== "string" || !label.trim() || label.length > 40) return "label must be 1–40 characters";
  if (description !== undefined && typeof description !== "string") return "description must be a string";
  if (widens !== undefined && typeof widens !== "boolean") return "widens must be true or false";
  if (typeof mount !== "function") return "mount must be a function";
  if (size !== undefined && typeof size !== "function") return "size must be a function";
  if (hidden !== undefined && typeof hidden !== "boolean") return "hidden must be true or false";
  const problem = optionsProblem(def.options);
  if (problem) return problem;
  return {
    id,
    label,
    mount: mount as AnyStyle["mount"],
    ...(description !== undefined && { description }),
    ...(widens !== undefined && { widens }),
    ...(size !== undefined && { size: size as NonNullable<AnyStyle["size"]> }),
    ...(hidden !== undefined && { hidden }),
    ...(def.options !== undefined && { options: def.options as NonNullable<AnyStyle["options"]> }),
  };
}

/**
 * The style as the island runs it: a failing `size` is reported and gives the plain pill, and its
 * view's failures are reported; the island then sets the style aside for another one.
 */
export function confineStyle(style: AnyStyle, log: (message: string) => void = console.error): AnyStyle {
  const report = (what: string, e: unknown) => log(`[island] pill style "${style.id}": ${what} failed: ${String(e)}`);
  const size = style.size;
  return {
    ...style,
    ...(size && {
      size(pill, options) {
        try {
          return size.call(style, pill, options);
        } catch (e) {
          report("size", e);
          return { width: pill.width, height: pill.height };
        }
      },
    }),
    mount(root, ctx) {
      const view = style.mount.call(style, root, ctx);
      if (!isObject(view) || typeof view.draw !== "function") throw new Error("mount must return a view with draw()");
      return view;
    },
  };
}

/** Wraps `fn` so that its first failure is reported and switches it off. */
function fuse<A extends unknown[], R>(what: string, fn: (...args: A) => R, fallback: R, report: (what: string, e: unknown) => void) {
  let blown = false;
  return (...args: A): R => {
    if (blown) return fallback;
    try {
      const out = fn(...args);
      if (out instanceof Promise)
        return out.catch((e: unknown) => {
          blown = true;
          report(what, e);
        }) as R;
      return out;
    } catch (e) {
      blown = true;
      report(what, e);
      return fallback;
    }
  };
}

/** A widget whose parts each stop on their first failure instead of throwing into the island. */
export function isolate(widget: Widget, report: (what: string, e: unknown) => void): Widget {
  const out: { -readonly [K in keyof Widget]: Widget[K] } = {};
  if (widget.panel) out.panel = fuse("panel", widget.panel, undefined, report);
  if (widget.glance) out.glance = fuse("glance", widget.glance, null, report);
  if (widget.tick) out.tick = fuse("tick", widget.tick, undefined, report);
  if (widget.ambient) out.ambient = fuse("ambient", widget.ambient, null, report);
  if (widget.onNotificationAction) out.onNotificationAction = fuse("onNotificationAction", widget.onNotificationAction, undefined, report);
  if (widget.onCommand) out.onCommand = fuse("onCommand", widget.onCommand, undefined, report);
  if (widget.onNotification) {
    // Switched off on its first failure: notifications then pass through untouched.
    const hook = widget.onNotification;
    let blown = false;
    out.onNotification = (n) => {
      if (blown) return n;
      try {
        return hook(n);
      } catch (e) {
        blown = true;
        report("onNotification", e);
        return n;
      }
    };
  }
  return out;
}

/** A service each plugin gets its own copy of, bound to its id: e.g. its accounts. */
export interface PerPlugin<T> {
  readonly forPlugin: (pluginId: string) => T;
}

export const perPlugin = <T>(forPlugin: (pluginId: string) => T): PerPlugin<T> => ({ forPlugin });

const isPerPlugin = (service: unknown): service is PerPlugin<unknown> => isObject(service) && typeof service.forPlugin === "function";

/** The plugin as the island runs it: given only the services it needs, and isolated. */
export function confine(plugin: AnyPlugin, needs: readonly string[], log: (message: string) => void = console.error): AnyPlugin {
  const report = (what: string, e: unknown) => log(`[island] plugin "${plugin.id}": ${what} failed and was turned off: ${String(e)}`);
  const grant = (services: unknown) => {
    const all = services as Record<string, unknown>;
    return Object.freeze(Object.fromEntries(needs.map((n) => [n, isPerPlugin(all[n]) ? all[n].forPlugin(plugin.id) : all[n]])));
  };
  /** Its Settings card and its page get the same services as the island does, and can't break the window. */
  const drawn =
    (what: string, draw: (root: HTMLElement, services: never, host: never) => (() => void) | void) =>
    (root: HTMLElement, services: never, host: never) => {
      try {
        const stop = draw.call(plugin, root, grant(services) as never, host);
        return typeof stop === "function" ? fuse(`${what} cleanup`, stop, undefined, report) : undefined;
      } catch (e) {
        report(what, e);
        // Drawn in Settings, which shows it as a notification.
        reportProblem(`${plugin.label}'s ${what} couldn't be shown`, e, what === "page" ? "PLUGIN_PAGE" : "PLUGIN_PANEL");
        return undefined;
      }
    };
  const { settingsPanel, page } = plugin;
  return {
    ...plugin,
    ...(settingsPanel && { settingsPanel: drawn("settings panel", settingsPanel) }),
    ...(page && { page: drawn("page", page) }),
    setup(services, host: Host<never>) {
      const granted = grant(services);
      try {
        const widget = plugin.setup(granted as never, host);
        const { onNotification, ...rest } = isObject(widget) ? (widget as Widget) : {};
        // Seeing every notification is what `needs: ["notifications"]` asks the user for.
        return isolate(needs.includes("notifications") && onNotification ? { ...rest, onNotification } : rest, report);
      } catch (e) {
        report("setup", e);
        return {};
      }
    },
  };
}

/** Loads and checks every plugin (startup animation, pill style) found, in order; later duplicates of an id are refused. */
export async function loadExtensions(found: readonly Found[], rules: Rules, importer: Importer = importSource, api: Sdk = sdk): Promise<Extension[]> {
  const taken = new Set(rules.taken);
  const out: Extension[] = [];
  for (const { file, source, problem } of found) {
    const fail = (why: string) => out.push({ file, plugin: null, greeting: null, style: null, notifier: null, needs: [], problem: why });
    if (source === null) {
      fail(problem ?? "couldn't be read");
      continue;
    }
    let def: unknown;
    try {
      const module = await importer(source);
      const factory = isObject(module) || typeof module === "function" ? (module as { default?: unknown }).default : undefined;
      if (typeof factory !== "function") {
        fail("must default-export a function that receives the island SDK");
        continue;
      }
      def = factory(api);
    } catch (e) {
      fail(`failed to load: ${String(e)}`);
      continue;
    }
    // A definition with `play` and no `setup` is a startup animation.
    if (isObject(def) && "play" in def && !("setup" in def)) {
      const greeting = checkGreeting(def, taken);
      if (typeof greeting === "string") {
        fail(greeting);
        continue;
      }
      taken.add(greeting.id);
      out.push({ file, plugin: null, greeting: confineGreeting(greeting), style: null, notifier: null, needs: [], problem: null });
      continue;
    }
    // A definition with `mount` and no `setup` is a pill style.
    if (isObject(def) && "mount" in def && !("setup" in def)) {
      const style = checkStyle(def, taken);
      if (typeof style === "string") {
        fail(style);
        continue;
      }
      taken.add(style.id);
      out.push({ file, plugin: null, greeting: null, style: confineStyle(style), notifier: null, needs: [], problem: null });
      continue;
    }
    // A definition with `show` and no `setup` is a way to show notifications.
    if (isObject(def) && "show" in def && !("setup" in def)) {
      const notifier = checkNotifier(def, taken);
      if (typeof notifier === "string") {
        fail(notifier);
        continue;
      }
      taken.add(notifier.id);
      out.push({ file, plugin: null, greeting: null, style: null, notifier: confineNotifier(notifier), needs: [], problem: null });
      continue;
    }
    const checked = check(def, { ...rules, taken });
    if (typeof checked === "string") {
      fail(checked);
      continue;
    }
    taken.add(checked.plugin.id);
    out.push({ file, plugin: confine(checked.plugin, checked.needs), greeting: null, style: null, notifier: null, needs: checked.needs, problem: null });
  }
  return out;
}

/** A plugin file as the Settings page lists it. */
export interface FileRow {
  readonly file: string;
  readonly on: boolean;
  /** Known only for files that are on and loaded fine: a file's code doesn't run before it is turned on. */
  readonly plugin: AnyPlugin | null;
  readonly greeting: Greeting | null;
  readonly style: AnyStyle | null;
  readonly notifier: Notifier | null;
  readonly needs: readonly string[];
  readonly problem: string | null;
}

/** Every file in the folder, plus files still turned on but gone from it, in name order. */
export function fileRows(found: readonly Pick<Found, "file">[], enabled: readonly string[], loaded: ReadonlyMap<string, Extension>): FileRow[] {
  const files = [...new Set([...found.map((f) => f.file), ...enabled])].sort();
  const present = new Set(found.map((f) => f.file));
  return files.map((file) => {
    const on = enabled.includes(file);
    const ext = on ? loaded.get(file) : undefined;
    const problem = on && !present.has(file) ? "No longer in the plugins folder" : (ext?.problem ?? null);
    const shown = present.has(file) ? ext : undefined;
    return { file, on, plugin: shown?.plugin ?? null, greeting: shown?.greeting ?? null, style: shown?.style ?? null, notifier: shown?.notifier ?? null, needs: ext?.needs ?? [], problem };
  });
}

export interface ExtensionsPort {
  /** Every plugin file in the plugins folder, and the folder itself. */
  list(): Promise<{ dir: string; plugins: Found[] }>;
  /** Shows the plugins folder in the file manager. */
  openDir(): Promise<void>;
}

export const tauriExtensions: ExtensionsPort = {
  list: () => commands.list(),
  openDir: async () => void (await commands.openDir()),
};

/** No plugins folder, for the browser previews. */
export const noExtensions: ExtensionsPort = {
  list: async () => ({ dir: "", plugins: [] }),
  openDir: async () => {},
};
