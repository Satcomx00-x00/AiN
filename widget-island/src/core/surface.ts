import { type Entry, type PopupPort, commandsOf } from "./commands";
import { EASE_OUT, reducedMotion } from "./dom";
import { resolve } from "./options";
import type { AnyPlugin, PopupView } from "./plugin";
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

  const viewFor = (entry: Entry) => {
    let built = views.get(entry.id);
    if (!built) {
      const root = document.createElement("div");
      root.className = "view";
      const view = entry.command.popup(root, {
        services,
        options: () => resolve(entry.plugin.options ?? {}, settings.options[entry.plugin.id]),
        close: () => void popup.hide(),
        paste: () => popup.paste(),
      } as never);
      built = { root, view };
      views.set(entry.id, built);
    }
    return built;
  };

  const show = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return void popup.hide();
    const { root, view } = viewFor(entry);
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
