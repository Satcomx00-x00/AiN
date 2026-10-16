import { EASE_OUT, h, icon, reducedMotion } from "../sdk/dom";
import type { Mounted } from "../sdk/plugin";

export interface Tabs {
  readonly bar: HTMLElement;
  readonly panels: HTMLElement;
  active(): string | undefined;
  select(id: string, animate?: boolean): void;
}

/** Segmented tab bar with a sliding highlight; each plugin renders into its own panel. */
export function tabs(placed: readonly Mounted[], onChange: (id: string) => void, initial?: string): Tabs {
  const indicator = h("span", { class: "tab-indicator", "aria-hidden": "true" });
  const bar = h("nav", { class: "tabs", role: "tablist" }, indicator);
  bar.style.setProperty("--n", String(placed.length));
  const panels = h("div", { class: "panels" });
  let current = placed.some((m) => m.plugin.id === initial) ? initial : placed[0]?.plugin.id;

  const views = placed.map(({ plugin: { id, label, icon: glyph }, widget }) => {
    // Icon-only so any number of tabs fits; the name is the tooltip and accessible label.
    const tab = h("button", { type: "button", role: "tab", id: `tab-${id}`, "aria-controls": `panel-${id}`, "aria-label": label, title: label }, icon(glyph));
    const panel = h("section", { role: "tabpanel", id: `panel-${id}`, "aria-labelledby": `tab-${id}` });
    widget.panel?.(panel);
    tab.addEventListener("click", () => select(id));
    bar.append(tab);
    panels.append(panel);
    return { id, tab, panel };
  });

  const show = (id: string, animate: boolean) => {
    const from = views.findIndex((v) => v.id === current);
    const to = views.findIndex((v) => v.id === id);
    current = id;
    for (const v of views) {
      v.tab.setAttribute("aria-selected", String(v.id === id));
      v.panel.hidden = v.id !== id;
    }
    // Positioned by index in CSS, so it is right at any width, even mid-animation.
    bar.style.setProperty("--i", String(to));
    const panel = views[to]?.panel;
    if (panel && animate && from !== to && !reducedMotion())
      panel.animate(
        [
          { opacity: 0, transform: `translateX(${to > from ? 14 : -14}px)`, filter: "blur(4px)" },
          { opacity: 1, transform: "none", filter: "none" },
        ],
        { duration: 340, easing: EASE_OUT },
      );
  };

  const select = (id: string, animate = true) => {
    show(id, animate);
    onChange(id);
  };

  if (current) show(current, false);
  return { bar, panels, active: () => current, select };
}
