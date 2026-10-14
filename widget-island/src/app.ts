import "./island.css";
import { type PopupPort, bindings, tauriPopup } from "./core/commands";
import { type IslandHandle, mount } from "./core/host";
import { type Settings, type SettingsPort, defaults, parseSettings, tauriSettings } from "./core/settings";
import { type WindowPort, tauriWindow } from "./core/window";
import { layout } from "./layout";
import { catalogue } from "./plugins";
import { type Services, tauriServices } from "./services";

/** Composition root: the catalogue of plugins, the stored settings, and what backend they talk to. */
export async function start(
  root: HTMLElement,
  services: Services = tauriServices,
  win: WindowPort = tauriWindow,
  store: SettingsPort = tauriSettings,
  popup: PopupPort = tauriPopup,
): Promise<IslandHandle> {
  const fallback = defaults(layout);
  let latest: Settings = fallback;
  let island: IslandHandle | undefined;

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

  await store.watch((raw) => {
    latest = parseSettings(raw, fallback);
    rebind(latest);
    island?.configure(latest);
  });
  const initial = latest;
  const openSettings = () => store.open().catch((e: unknown) => console.error("[island] could not open settings", e));
  const saveOptions = (id: string, patch: Readonly<Record<string, unknown>>) => {
    latest = { ...latest, options: { ...latest.options, [id]: { ...latest.options[id], ...patch } } };
    island?.configure(latest);
    store.save(latest).catch((e: unknown) => console.error("[island] could not save options", e));
  };
  island = await mount(root, catalogue, services, win, initial, openSettings, saveOptions);
  // Settings that changed while the island was starting.
  if (latest !== initial) island.configure(latest);
  return island;
}
