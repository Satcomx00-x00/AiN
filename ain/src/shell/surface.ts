import { type Entry, type PopupPort, commandsOf, shortcutOf, surfaceOf } from "./commands";
import { EASE_OUT, reducedMotion } from "../sdk/dom";
import { resolve } from "../sdk/options";
import type { AnyPlugin, CommandInfo, PopupView } from "../sdk/plugin";
import { type Settings, type SettingsPort, defaults, parseSettings } from "./settings";
import type { Layout } from "./placement";

export interface SurfaceOptions {
  /** Where command views are mounted. */
  readonly container: HTMLElement;
  readonly catalogue: readonly AnyPlugin[];
  readonly layout: Layout;
  readonly services: unknown;
  readonly popup: PopupPort;
  readonly store: SettingsPort;
}

/**
 * Hosts commands in a window (the popup or the capture overlay): builds each command's view once,
 * shows the one asked for, and hides the window on Esc or when it loses focus.
 */
export function hostCommands({ container, catalogue, layout, services, popup, store }: SurfaceOptions): void {
  const fallback = defaults(layout);
  let settings: Settings = fallback;
  void store.watch((raw) => (settings = parseSettings(raw, fallback)));

  const entries = commandsOf(catalogue);
  const views = new Map<string, { root: HTMLElement; view: PopupView }>();
  const infos = (): CommandInfo[] =>
    entries.map((e) => ({ id: e.id, label: e.command.label, description: e.command.description, icon: e.plugin.icon, shortcut: shortcutOf(e, settings.shortcuts) }));
  const run = async (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    await popup.hide();
    await popup.open(id, surfaceOf(entry));
  };

  const viewFor = (entry: Entry) => {
    let built = views.get(entry.id);
    if (!built && entry.command.popup) {
      const root = document.createElement("div");
      root.className = "view";
      const view = entry.command.popup(root, {
        services,
        options: () => resolve(entry.plugin.options ?? {}, settings.options[entry.plugin.id]),
        close: () => void popup.hide(),
        paste: () => popup.paste(),
        commands: infos,
        run,
        openSettings: (target?: string) => store.open(target),
        quit: () => store.quit(),
      } as never);
      built = { root, view };
      views.set(entry.id, built);
    }
    return built;
  };

  const show = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    const built = entry && viewFor(entry);
    if (!entry || !built) return void popup.hide();
    const { root, view } = built;
    if (container.firstChild !== root) container.replaceChildren(root);
    document.title = entry.command.label;
    view.show();
    if (!reducedMotion())
      container.animate([{ opacity: 0, transform: "scale(0.98)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: EASE_OUT });
  };

  void popup.onShow(show);
  // The first show happens before the page has loaded, so it arrives in the URL instead.
  if (location.hash.length > 1) show(decodeURIComponent(location.hash.slice(1)));

  // Views may handle Esc themselves first (and prevent the default) — e.g. to drop a selection.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) void popup.hide();
  });
  window.addEventListener("blur", () => void popup.hide());
}
