import { isLight } from "../sdk/color";
import { palette, themeById } from "./themes";
import { animates, button, h, icon, reducedMotion } from "../sdk/dom";
import { EAR, EXPANDED, frame, sizeFor } from "./geometry";
import { glanceSlot } from "../sdk/glance";
import { intent } from "./intent";
import { type Fields, resolve } from "../sdk/options";
import { type Layout, type Placement, pickFrom, place, placedIds } from "./placement";
import type { AnyPlugin, Host, Mounted, Plugin } from "../sdk/plugin";
import { POWER, armedButton } from "./quit";
import type { Greeting } from "../sdk/greeting";
import { greet } from "./greet";
import { ticker } from "./scheduler";
import type { Settings } from "./settings";
import { type Tabs, tabs } from "./tabs";
import type { Island, Size, WindowPort } from "./window";

/** The island as the settings shape it: the chosen width, unless a hardware notch dictates it. */
export const shaped = (i: Island, general: Settings["general"]): Island => (i.hasNotch ? i : { ...i, width: general.pillWidth });

/** How long the open island takes to fold back (its 0.5 s size transition), in ms. */
const CLOSING = 500;

/** Lucide's "settings" cog (ISC), drawn on a 24 grid and scaled into our 16 px icons. */
const GEAR = `<g transform="scale(0.6667)" stroke-width="2.25"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></g>`;

const IDLE_HOST: Host<never> = {
  refresh() {},
  options: () => ({}) as never,
  setOptions() {},
  openSettings() {},
};

/**
 * Sets up the plugins the layout places that aren't in `into` yet, once each, in catalogue order.
 * Plugins already set up keep their state.
 */
export function load<S>(
  catalogue: readonly Plugin<S, Fields>[],
  layout: Layout,
  services: S,
  hostFor: (plugin: AnyPlugin) => Host<never> = () => IDLE_HOST,
  into = new Map<string, Mounted>(),
): { mounted: Map<string, Mounted>; problems: string[] } {
  const wanted = placedIds(layout);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const plugin of catalogue) {
    if (seen.has(plugin.id)) problems.push(`duplicate plugin id "${plugin.id}"`);
    seen.add(plugin.id);
    if (wanted.has(plugin.id) && !into.has(plugin.id)) into.set(plugin.id, { plugin, widget: plugin.setup(services, hostFor(plugin)) });
  }
  return { mounted: into, problems };
}

/** Each placed plugin once, wherever it appears. */
const placedOnce = (p: Placement): Mounted[] => [...new Set([...p.left, ...p.right, ...p.tabs])];

/** What the island can do beyond showing plugins. */
export interface Extras {
  /** Opens Settings, at `target` ("widgets:<plugin id>") when given. */
  readonly openSettings?: (target?: string) => void;
  readonly saveOptions?: (pluginId: string, patch: Readonly<Record<string, unknown>>) => void;
  /** Quits the whole app. */
  readonly quit?: () => void;
  /** Startup animations to choose from (settings.general.greeting), the default first. */
  readonly greetings?: readonly Greeting[];
}

export interface IslandHandle<S = never> {
  /**
   * Applies new settings live: layout, delays and plugin options. Plugins keep their state.
   * `catalogue`, when given, replaces the plugins available (e.g. once more are loaded), and
   * `greetings` the startup animations.
   */
  configure(settings: Settings, catalogue?: readonly Plugin<S, Fields>[], greetings?: readonly Greeting[]): void;
  /** Plays the startup animation `id` (the chosen one when not given), once the island is idle. */
  play(id?: string): void;
}

/** The island shell: places plugins per the settings, runs the 1 s beat and the open/close choreography. */
export async function mount<S>(
  el: HTMLElement,
  catalogue: readonly Plugin<S, Fields>[],
  services: S,
  win: WindowPort,
  initial: Settings,
  extras: Extras = {},
): Promise<IslandHandle<S>> {
  const { openSettings, saveOptions, quit } = extras;
  let greetings = extras.greetings ?? [];
  const hardware = await win.island();
  let plugins = catalogue;
  let settings = initial;
  let i = shaped(hardware, initial.general);
  // Plugins may push updates before the beat exists; those land on the first beat anyway.
  let refresh = () => {};
  const hostFor = (plugin: AnyPlugin): Host<never> => ({
    refresh: () => refresh(),
    options: () => resolve(plugin.options ?? {}, settings.options[plugin.id]) as never,
    setOptions: (patch) => saveOptions?.(plugin.id, patch),
    openSettings: () => openSettings?.(`widgets:${plugin.id}`),
  });
  const mounted = new Map<string, Mounted>();
  let placement: Placement = { left: [], right: [], tabs: [] };
  let active: Mounted[] = [];

  el.dataset.notch = String(i.hasNotch);
  el.dataset.open = "false";
  el.dataset.hidden = "false";
  el.style.setProperty("--ear", `${EAR}px`);
  el.style.setProperty("--glance-h", `${i.height}px`);
  el.style.setProperty("--panel-h", `${EXPANDED.height}px`);
  let canvas = frame(sizeFor(true, i), true);
  const reshape = () => {
    // Panel content is laid out once at its final size; the pill only reveals it, so nothing reflows mid-animation.
    el.style.setProperty("--panel-w", `${sizeFor(true, i).width}px`);
    el.style.setProperty("--curve", String(settings.general.pillCurve / 100));
    const { theme, pillColor, accentColor } = settings.general;
    for (const [name, value] of Object.entries(palette(themeById(theme), pillColor, accentColor))) el.style.setProperty(name, value);
    el.dataset.tone = isLight(settings.general.pillColor) ? "light" : "dark";
    canvas = frame(sizeFor(true, i), true);
  };
  reshape();
  let open = false;
  /** Set once the startup animation is over. */
  let started = false;
  /** False while a startup animation plays: the pill doesn't open meanwhile. */
  let ready = false;
  // A glance may widen the collapsed pill into a live activity (music, a volume change…).
  let wide = false;

  const left = glanceSlot();
  const right = glanceSlot();
  const panel = h("div", { class: "panel" });
  const gear = openSettings && button(icon(GEAR), () => openSettings(), { class: "gear", "aria-label": "Settings", title: "Settings" });
  const power = quit && armedButton(POWER, quit, { label: "Quit Island", armed: "Click again to quit Island" }, "gear quit");
  let view: Tabs | undefined;
  const alerting = (now: number) => active.find((m) => m.widget.glance?.(now)?.tone === "alert");

  const apply = ({ width, height }: Size) => {
    el.style.setProperty("--w", `${width}px`);
    el.style.setProperty("--h", `${height}px`);
  };

  const beat = ticker(async () => {
    const now = Date.now();
    await Promise.allSettled(active.map((m) => m.widget.tick?.({ now, visible: open && m.plugin.id === view?.active() })));
    const l = pickFrom(placement.left, now);
    const r = pickFrom(placement.right, now);
    left.draw(l?.glance ?? null, l?.from.plugin.id);
    right.draw(r?.glance ?? null, r?.from.plugin.id);
    el.dataset.alert = String(alerting(now) !== undefined);

    // Tint follows what's in focus: the open tab, or whoever speaks on the collapsed pill.
    const focus = open ? active.find((m) => m.plugin.id === view?.active()) : (r?.from ?? l?.from);
    const ambient = focus?.widget.ambient?.() ?? null;
    if (ambient) el.style.setProperty("--ambient", ambient);
    else el.style.removeProperty("--ambient");

    const nextWide = !!(l?.glance.wide || r?.glance.wide);
    if (nextWide !== wide) {
      wide = nextWide;
      el.dataset.wide = String(wide);
      if (!open) {
        const s = sizeFor(false, i, wide);
        // Grow the input region before the pill does; shrink it after.
        if (wide) await win.layout(canvas, frame(s));
        apply(s);
        if (!wide) void win.layout(canvas, frame(s));
      }
    }
  });
  refresh = () => beat.now();

  // One preview at a time; asks made while one plays wait for it, and only the last one plays.
  let previews: Promise<void> = Promise.resolve();
  let asked = 0;
  const preview = (id?: string) => {
    if (!started) return;
    const turn = ++asked;
    previews = previews.then(async () => {
      if (turn !== asked || open) return;
      ready = false;
      await greet(el, sizeFor(false, i, wide), greetings, id ?? settings.general.greeting, !reducedMotion());
      ready = true;
    });
  };

  // Hidden until the cursor rests at the top center; once shown, it hides again when the island
  // has had time to close after the cursor left. Sent only when it changes.
  let rule = "";
  const autoHide = () => {
    const { autoHide: on, revealDelay, closeDelay } = settings.general;
    const dwell = on ? revealDelay : null;
    const grace = closeDelay + CLOSING;
    if (`${dwell}/${grace}` === rule) return;
    rule = `${dwell}/${grace}`;
    win.autoHide(dwell, grace).catch((e: unknown) => console.error("[island] could not set auto-hide", e));
  };

  const configure = (next: Settings,nextCatalogue?: readonly Plugin<S, Fields>[], nextGreetings?: readonly Greeting[]) => {
    // Picking another startup animation in Settings plays it, as a preview.
    const replay = started && next.general.greeting !== settings.general.greeting;
    settings = next;
    if (nextCatalogue) plugins = nextCatalogue;
    if (nextGreetings) greetings = nextGreetings;
    if (replay && !open) preview();
    const nextShape = shaped(hardware, next.general);
    const resized = nextShape.width !== i.width;
    i = nextShape;
    reshape();
    if (started) autoHide();
    if (resized) {
      const s = sizeFor(open, i, wide);
      apply(s);
      void win.layout(canvas, frame(s, open));
    }
    const loaded = load(plugins, next.layout, services, hostFor, mounted);
    const placed = place(mounted, next.layout);
    for (const p of [...loaded.problems, ...placed.problems]) console.warn(`[island] ${p}`);
    placement = placed.placement;
    active = placedOnce(placement);
    view = tabs(placement.tabs, () => beat.now(), view?.active());
    panel.replaceChildren(h("div", { class: "panel-head" }, view.bar, ...(gear ? [gear] : []), ...(power ? [power] : [])), view.panels);
    beat.now();
  };

  el.append(h("div", { class: "surface" }, h("div", { class: "glance" }, left.el, right.el), panel));
  configure(initial);

  // Grow the input region before the pill animates out; shrink it only after the pill has animated in.
  const toggle = async (next: boolean) => {
    // Not while a startup animation plays: it drives the pill's size.
    if (next === open || (next && !ready)) return;
    open = next;
    const s = sizeFor(open, i, wide);
    if (open) {
      await win.layout(canvas, frame(s, true));
      if (!open) return;
      const alert = alerting(Date.now());
      if (alert && placement.tabs.includes(alert) && alert.plugin.id !== view?.active()) view?.select(alert.plugin.id, false);
      el.dataset.open = "true";
      apply(s);
      beat.now();
      return;
    }
    el.dataset.open = "false";
    apply(s);
    if (!animates(getComputedStyle(el).transitionDuration)) return win.layout(canvas, frame(s));
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== "height") return;
      el.removeEventListener("transitionend", onEnd);
      if (!open) void win.layout(canvas, frame(s));
    };
    el.addEventListener("transitionend", onEnd);
  };

  const hover = intent(
    (o) => void toggle(o),
    () => open,
    () => ({ open: settings.general.openDelay, close: settings.general.closeDelay }),
  );

  await win.onReveal((shown) => {
    el.dataset.hidden = String(!shown);
    if (!shown) hover.set(false);
  });

  apply(sizeFor(false, i));
  await win.layout(canvas, frame(sizeFor(false, i)));

  beat.start();
  // The startup animation plays first; hovering (and auto-hiding) waits for it.
  void greet(el, sizeFor(false, i), greetings, settings.general.greeting, !reducedMotion()).then(() => {
    started = ready = true;
    autoHide();
    el.addEventListener("pointerenter", hover.enter);
    el.addEventListener("pointerleave", hover.leave);
    el.addEventListener("click", () => hover.set(true));
    document.documentElement.addEventListener("mouseleave", hover.leave);
    window.addEventListener("blur", () => hover.set(false));
  });
  return { configure, play: (id) => preview(id) };
}
