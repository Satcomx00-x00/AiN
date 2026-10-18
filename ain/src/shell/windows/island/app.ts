import "./island.css";
import { catalogue, extensionRules } from "../../../features";
import { greetings } from "../../../features/greetings";
import { layout } from "../../../features/layout";
import { styles } from "../../../features/styles";
import { type Services, tauriServices } from "../../../features/services";
import type { Greeting } from "../../../sdk/greeting";
import type { Fields } from "../../../sdk/options";
import type { Plugin } from "../../../sdk/plugin";
import type { AnyStyle } from "../../../sdk/style";
import { type PopupPort, bindings, tauriPopup } from "../../commands";
import { type Extension, type ExtensionsPort, type Importer, idOf, importSource, loadExtensions, tauriExtensions } from "../../extensions";
import { type IslandHandle, mount } from "../../host";
import { type SecretsPort, secretReader, tauriSecrets } from "../../secrets";
import { type Settings, type SettingsPort, defaults, parseSettings, runnable, tauriSettings } from "../../settings";
import { type WindowPort, tauriWindow } from "../../window";

/**
 * Plugins from the plugins folder, loaded once each when first turned on. Files turned off later
 * keep their (idle) plugin until the app restarts, but leave the layout at once.
 */
export function extensionLoader(port: ExtensionsPort, importer: Importer = importSource, log: (message: string) => void = console.warn) {
  const done = new Map<string, Extension>();
  // One sync at a time: two quick settings changes must not load the same file twice.
  let queue: Promise<unknown> = Promise.resolve();
  const sync = async (enabled: readonly string[]): Promise<Extension[]> => {
    const fresh = enabled.filter((file) => !done.has(file));
    if (fresh.length) {
      const listing = await port.list().catch((e: unknown) => (log(`[island] can't list plugins: ${String(e)}`), { dir: "", plugins: [] }));
      const found = listing.plugins.filter((p) => fresh.includes(p.file));
      const taken = new Set([...extensionRules.taken, ...[...done.values()].flatMap((e) => idOf(e) ?? [])]);
      for (const ext of await loadExtensions(found, { ...extensionRules, taken }, importer)) {
        done.set(ext.file, ext);
        if (ext.problem) log(`[island] plugin ${ext.file}: ${ext.problem}`);
      }
      // Not marked done: it may show up later (the island keeps checking on each settings change).
      for (const file of fresh.filter((f) => !done.has(f))) log(`[island] plugin ${file} is turned on but not in the plugins folder`);
    }
    return [...done.values()];
  };
  return {
    /** Loads the newly enabled files among `enabled`; resolves with every plugin loaded so far. */
    sync(enabled: readonly string[]): Promise<Extension[]> {
      const run = queue.then(() => sync(enabled));
      queue = run.catch(() => {});
      return run;
    },
  };
}

/** Composition root: the catalogue of plugins, the stored settings, and what backend they talk to. */
export async function start(
  root: HTMLElement,
  services: Services = tauriServices,
  win: WindowPort = tauriWindow,
  store: SettingsPort = tauriSettings,
  popup: PopupPort = tauriPopup,
  extensions: ExtensionsPort = tauriExtensions,
  importer: Importer = importSource,
  secrets: SecretsPort = tauriSecrets,
): Promise<IslandHandle<Services>> {
  const fallback = defaults(layout);
  const loader = extensionLoader(extensions, importer);
  let latest: Settings = fallback;
  let island: IslandHandle<Services> | undefined;
  let plugins: readonly Plugin<Services, Fields>[] = catalogue;
  let loaded: { file: string; id: string }[] = [];
  /** Built-in startup animations, then those from enabled files. */
  let choices: readonly Greeting[] = greetings;
  /** Built-in pill styles, then those from enabled files. */
  let looks: readonly AnyStyle[] = styles;

  // Global shortcuts follow the settings; re-registered only when they actually change.
  let bound = "";
  const rebind = (settings: Settings) => {
    const map = bindings(catalogue, settings.shortcuts);
    const key = JSON.stringify(map);
    if (key === bound) return;
    bound = key;
    popup.bind(map).then(
      (failed) => Object.entries(failed).forEach(([id, why]) => console.warn(`[island] shortcut for ${id}: ${why}`)),
      (e: unknown) => console.error("[island] could not register shortcuts", e),
    );
  };

  /** The settings as the island runs them: only plugins from enabled files placed. */
  const effective = (s: Settings): Settings => ({ ...s, layout: runnable(s, loaded) });

  /** Loads newly enabled plugin files, then applies `settings` with them. */
  const apply = async (settings: Settings) => {
    const all = await loader.sync(settings.extensions);
    loaded = all.flatMap((e) => (e.plugin ? [{ file: e.file, id: e.plugin.id }] : []));
    plugins = [...catalogue, ...all.flatMap((e) => (e.plugin ? [e.plugin as Plugin<Services, Fields>] : []))];
    choices = [...greetings, ...all.flatMap((e) => (e.greeting && settings.extensions.includes(e.file) ? [e.greeting] : []))];
    looks = [...styles, ...all.flatMap((e) => (e.style && settings.extensions.includes(e.file) ? [e.style] : []))];
    // Newer settings may have arrived while loading; those win.
    if (settings === latest) island?.configure(effective(settings), plugins, choices, looks);
  };

  await store.watch((raw) => {
    latest = parseSettings(raw, fallback);
    rebind(latest);
    island?.configure(effective(latest));
    void apply(latest);
  });
  await apply(latest);
  const initial = latest;
  const openSettings = (target?: string) => store.open(target).catch((e: unknown) => console.error("[island] could not open settings", e));
  const saveOptions = (id: string, patch: Readonly<Record<string, unknown>>) => {
    latest = { ...latest, options: { ...latest.options, [id]: { ...latest.options[id], ...patch } } };
    island?.configure(effective(latest));
    store.save(latest).catch((e: unknown) => console.error("[island] could not save options", e));
  };
  const readSecret = secretReader(secrets);
  const quit = () => void store.quit().catch((e: unknown) => console.error("[island] could not quit", e));
  // The Play button in Settings.
  await store.onPlayGreeting((id) => island?.play(id));
  island = await mount(root, plugins, services, win, effective(initial), { openSettings, saveOptions, readSecret, quit, greetings: choices, styles: looks });
  // Settings that changed while the island was starting.
  if (latest !== initial) island.configure(effective(latest), plugins);
  return island;
}
