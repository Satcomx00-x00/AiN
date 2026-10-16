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
import type { Greeting, Stage } from "../sdk/greeting";
import type { Field } from "../sdk/options";
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
  /** Services it asked for. */
  readonly needs: readonly string[];
  /** Why it can't be used, when it can't. */
  readonly problem: string | null;
}

/** The id a loaded file claims, if any. */
export const idOf = (ext: Extension): string | null => ext.plugin?.id ?? ext.greeting?.id ?? ext.style?.id ?? null;

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
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why `options` can't drive the settings page, or null when every field is well-formed. */
function optionsProblem(options: unknown): string | null {
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
  }
  return null;
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
  if (cmds !== undefined && !(Array.isArray(cmds) && cmds.length === 0)) return "shortcut commands are only available to built-in features";
  if (!Array.isArray(needs) || !needs.every((n) => typeof n === "string")) return "needs must list service names";
  const unknown = needs.filter((n: string) => !rules.services.includes(n));
  if (unknown.length) return `unknown services: ${unknown.join(", ")} (available: ${rules.services.join(", ")})`;
  const problem = optionsProblem(def.options);
  if (problem) return problem;
  return { plugin: def as unknown as AnyPlugin, needs: [...new Set(needs as string[])] };
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
  return out;
}

/** The plugin as the island runs it: given only the services it needs, and isolated. */
export function confine(plugin: AnyPlugin, needs: readonly string[], log: (message: string) => void = console.error): AnyPlugin {
  const report = (what: string, e: unknown) => log(`[island] plugin "${plugin.id}": ${what} failed and was turned off: ${String(e)}`);
  const grant = (services: unknown) => {
    const all = services as Record<string, unknown>;
    return Object.freeze(Object.fromEntries(needs.map((n) => [n, all[n]])));
  };
  const panel = plugin.settingsPanel;
  return {
    ...plugin,
    // Its Settings card gets the same services as the island does, and can't break the page.
    ...(panel && {
      settingsPanel(root: HTMLElement, services: never, host: never) {
        try {
          const stop = panel.call(plugin, root, grant(services) as never, host);
          return typeof stop === "function" ? fuse("settings panel cleanup", stop, undefined, report) : undefined;
        } catch (e) {
          report("settings panel", e);
          return undefined;
        }
      },
    }),
    setup(services, host: Host<never>) {
      const granted = grant(services);
      try {
        const widget = plugin.setup(granted as never, host);
        return isolate(isObject(widget) ? (widget as Widget) : {}, report);
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
    const fail = (why: string) => out.push({ file, plugin: null, greeting: null, style: null, needs: [], problem: why });
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
      out.push({ file, plugin: null, greeting: confineGreeting(greeting), style: null, needs: [], problem: null });
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
      out.push({ file, plugin: null, greeting: null, style: confineStyle(style), needs: [], problem: null });
      continue;
    }
    const checked = check(def, { ...rules, taken });
    if (typeof checked === "string") {
      fail(checked);
      continue;
    }
    taken.add(checked.plugin.id);
    out.push({ file, plugin: confine(checked.plugin, checked.needs), greeting: null, style: null, needs: checked.needs, problem: null });
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
    return { file, on, plugin: shown?.plugin ?? null, greeting: shown?.greeting ?? null, style: shown?.style ?? null, needs: ext?.needs ?? [], problem };
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
