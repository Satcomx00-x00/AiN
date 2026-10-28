import { EASE_OUT, h, icon, reducedMotion } from "../sdk/dom";
import type { Mounted } from "../sdk/plugin";

export interface Tabs {
  readonly bar: HTMLElement;
  readonly panels: HTMLElement;
  /** The shown plugin's id; none while the More list shows. */
  active(): string | undefined;
  select(id: string, animate?: boolean): void;
}

/** The most tabs the bar holds, so each stays wide enough to hit; the rest wait behind a last "More" tab. */
export const MAX_TABS = 10;

/** The bar's padding, where the highlight starts (`.tabs` and `.tab-indicator` in island.css). */
const INSET = 3;

const MORE = `<circle cx="3.5" cy="8" r="1.25" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor" stroke="none"/>`;

/** Segmented tab bar with a sliding highlight; each plugin renders into its own panel. */
export function tabs(placed: readonly Mounted[], onChange: (id: string) => void, initial?: string): Tabs {
  const indicator = h("span", { class: "tab-indicator", "aria-hidden": "true" });
  const bar = h("nav", { class: "tabs", role: "tablist" }, indicator);
  const panels = h("div", { class: "panels" });
  const extra = placed.slice(MAX_TABS);
  bar.style.setProperty("--n", String(Math.min(placed.length, MAX_TABS) + (extra.length ? 1 : 0)));
  let current = placed.some((m) => m.plugin.id === initial) ? initial : placed[0]?.plugin.id;
  /** True while the More tab shows its list rather than a plugin. */
  let listing = false;

  const views = placed.map(({ plugin: { id, label, icon: glyph }, widget }, i) => {
    // Icon-only so the tabs fit; the name is the tooltip and accessible label.
    const tab = i < MAX_TABS ? h("button", { type: "button", role: "tab", id: `tab-${id}`, "aria-controls": `panel-${id}`, "aria-label": label, title: label }, icon(glyph)) : null;
    const panel = h("section", { role: "tabpanel", id: `panel-${id}`, ...(tab ? { "aria-labelledby": `tab-${id}` } : { "aria-label": label }) });
    widget.panel?.(panel);
    tab?.addEventListener("click", () => select(id));
    if (tab) bar.append(tab);
    panels.append(panel);
    return { id, glyph, tab, panel };
  });

  // Past the limit: one more tab, whose panel lists the rest by name.
  const more = extra.length
    ? (() => {
        const names = extra.map((m) => m.plugin.label).join(", ");
        const tab = h("button", { type: "button", role: "tab", id: "tab-more", "aria-controls": "panel-more", "aria-label": `More: ${names}`, title: `More: ${names}` });
        const panel = h(
          "section",
          { role: "tabpanel", id: "panel-more", "aria-labelledby": "tab-more", class: "more-list" },
          ...extra.map(({ plugin: { id, label, icon: glyph } }) => {
            const row = h("button", { type: "button", class: "more-item", "data-id": id }, icon(glyph), h("span", {}, label));
            row.addEventListener("click", () => select(id));
            return row;
          }),
        );
        tab.addEventListener("click", () => list());
        bar.append(tab);
        panels.append(panel);
        return { tab, panel };
      })()
    : null;

  /**
   * Puts the highlight under the selected tab as laid out. Placed by index alone it drifts: engines
   * round each tab's width (WebKit by over a pixel across a narrow bar). Until the bar is laid out
   * (folded, or not on screen yet) the index places it.
   */
  const align = () => {
    const at = listing ? MAX_TABS : views.findIndex((v) => v.id === current);
    // The More list, or a plugin from it, is under the More tab.
    const tab = at >= MAX_TABS ? more?.tab : views[at]?.tab;
    if (!tab?.offsetWidth) return;
    bar.style.setProperty("--x", `${tab.offsetLeft - INSET}px`);
    bar.style.setProperty("--w", `${tab.offsetWidth}px`);
  };
  // The bar's width changes as the pill opens, or takes another size.
  new ResizeObserver(align).observe(bar);

  const show = (id: string | null, animate: boolean) => {
    const from = listing ? MAX_TABS : views.findIndex((v) => v.id === current);
    const to = id === null ? MAX_TABS : views.findIndex((v) => v.id === id);
    listing = id === null;
    if (id !== null) current = id;
    for (const v of views) {
      v.tab?.setAttribute("aria-selected", String(v.id === id));
      v.panel.hidden = v.id !== id;
    }
    if (more) {
      more.tab.setAttribute("aria-selected", String(to >= MAX_TABS));
      more.panel.hidden = !listing;
      // Holding a plugin from the list, it wears that plugin's icon, so the bar says what is open.
      more.tab.replaceChildren(icon(to >= MAX_TABS && !listing ? views[to]!.glyph : MORE));
    }
    bar.style.setProperty("--i", String(Math.min(to, MAX_TABS)));
    align();
    const panel = listing ? more?.panel : views[to]?.panel;
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
  const list = () => {
    show(null, true);
    onChange("more");
  };

  if (current) show(current, false);
  return { bar, panels, active: () => (listing ? undefined : current), select };
}
