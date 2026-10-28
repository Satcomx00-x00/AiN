import { isLight } from "../sdk/color";
import { palette, themeById } from "./themes";
import { EASE_OUT, animates, button, h, icon, reducedMotion } from "../sdk/dom";
import { toNotice } from "./notice-formats";
import { bubbleCanvas, frame, panelHeight, pillOf, sizeFor } from "./geometry";
import { intent } from "./intent";
import { type Fields, resolve } from "../sdk/options";
import { type Dress, type Layout, type Placement, type Shown, pickAll, place, placedIds } from "./placement";
import type { AnyPlugin, Appearance, CommandKind, Host, HostEvents, Mounted, Plugin } from "../sdk/plugin";
import type { NoticeSource, Notifier } from "../sdk/notify";
import { type Center, type Hook, center as newCenter } from "./notifications";
import { type NoticeView, type ToastPort, noToasts, noticeView } from "./notice-view";
import { POWER, armedButton } from "./quit";
import type { Greeting } from "../sdk/greeting";
import { greet } from "./greet";
import { ticker } from "./scheduler";
import { type Settings, pageTarget } from "./settings";
import type { AnyStyle, Folded, Pill, StyleView } from "../sdk/style";
import { BARE, foldedSize, styleById, styleOptions } from "./styles";
import { type Tabs, tabs } from "./tabs";
import type { Area, Island, Size, WindowPort } from "./window";

/** The island as the settings shape it: the chosen width, unless a hardware notch dictates it. */
export const shaped = (i: Island, general: Settings["general"]): Island => (i.hasNotch ? i : { ...i, width: general.pillWidth });

/** The pill's text and accent colors, which notification cards take. */
const colorsOf = (s: Settings): { fg: string; accent: string } => ({ fg: palette(themeById(s.general.theme), s.general.pillColor, s.general.accentColor)["--fg"]!, accent: s.general.accentColor });

/** How long the open island takes to fold back (its 0.5 s size transition), in ms. */
const CLOSING = 500;

/** Lucide's "settings" cog (ISC), drawn on a 24 grid and scaled into our 16 px icons. */
const GEAR = `<g transform="scale(0.6667)" stroke-width="2.25"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></g>`;

const IDLE_HOST: Host<never> = {
  refresh() {},
  options: () => ({}) as never,
  setOptions() {},
  secret: async () => "",
  openSettings() {},
  openPage() {},
  appearance: (): Appearance => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }),
  notify: () => ({ id: "", update() {}, dismiss() {} }),
  on: () => () => {},
};

/** Who a plugin's notifications come from. */
export const sourceOf = (plugin: AnyPlugin): NoticeSource => ({ id: plugin.id, label: plugin.label, icon: plugin.icon });

/** The `notifications` hooks of the plugins set up, in catalogue order. */
export const hooksOf = (mounted: ReadonlyMap<string, Mounted>): Hook[] =>
  [...mounted.values()].flatMap(({ plugin, widget }) => (widget.onNotification ? [{ pluginId: plugin.id, run: widget.onNotification }] : []));

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

/** Who shows its icon on the pill, and who stays there while idle. */
const dressOf = ({ pill }: Settings): Dress => ({ icons: new Set(pill.icons), idle: new Set(pill.idle) });
const spoken = ({ from, glance }: Shown) => ({ glance, from: from.plugin.id });

/** Each placed plugin once, wherever it appears. */
const placedOnce = (p: Placement): Mounted[] => [...new Set([...p.left, ...p.right, ...p.tabs])];

/** What the island can do beyond showing plugins. */
export interface Extras {
  /** Opens Settings, at `target` ("widgets:<plugin id>") when given. */
  readonly openSettings?: (target?: string) => void;
  readonly saveOptions?: (pluginId: string, patch: Readonly<Record<string, unknown>>) => void;
  /** Reads a plugin's secret from the credential store; "" when none is saved. */
  readonly readSecret?: (pluginId: string, key: string) => Promise<string>;
  /** Quits the whole app. */
  readonly quit?: () => void;
  /** Startup animations to choose from (settings.general.greeting), the default first. */
  readonly greetings?: readonly Greeting[];
  /** Pill styles to choose from (settings.general.style), the default first. */
  readonly styles?: readonly AnyStyle[];
  /** The notification center plugins post to; one of its own when not given. */
  readonly notices?: Center;
  /** The corner window toasts show in. */
  readonly toasts?: ToastPort;
  /** Ways to show notifications from plugin files (settings.notifications.format). */
  readonly notifiers?: readonly Notifier[];
}

export interface IslandHandle<S = never> {
  /**
   * Applies new settings live: layout, delays, the pill's style and size, and plugin options.
   * Plugins keep their state. `catalogue`, when given, replaces the plugins available (e.g. once
   * more are loaded), `greetings` the startup animations and `styles` the pill styles.
   */
  configure(settings: Settings, catalogue?: readonly Plugin<S, Fields>[], greetings?: readonly Greeting[], styles?: readonly AnyStyle[], notifiers?: readonly Notifier[]): void;
  /** Plays the startup animation `id` (the chosen one when not given), once the island is idle. */
  play(id?: string): void;
  /** Hands the shortcut of command `<plugin>.<command>` to that plugin's widget. */
  command(id: string, kind: CommandKind): void;
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
  const { openSettings, saveOptions, readSecret, quit } = extras;
  let greetings = extras.greetings ?? [];
  let styles = extras.styles ?? [];
  let notifiers = extras.notifiers ?? [];
  const notices = extras.notices ?? newCenter();
  /** What each plugin listens to with `host.on`. */
  const listeners = new Map<string, Map<keyof HostEvents, Set<(payload: never) => void>>>();
  /** Tells one plugin's `event` listeners. */
  const tell = <E extends keyof HostEvents>(id: string, event: E, payload: HostEvents[E]) => {
    for (const listener of listeners.get(id)?.get(event) ?? []) {
      try {
        (listener as (p: HostEvents[E]) => void)(payload);
      } catch (e) {
        console.error(`[island] plugin "${id}": its "${event}" listener failed: ${String(e)}`);
      }
    }
  };
  const emit = <E extends keyof HostEvents>(event: E, payload: () => HostEvents[E]) => {
    for (const id of listeners.keys()) tell(id, event, payload());
  };
  const hardware = await win.island();
  let plugins = catalogue;
  let settings = initial;
  let i = shaped(hardware, initial.general);
  const hostFor = (plugin: AnyPlugin): Host<never> => ({
    // Plugins are only set up once the beat exists (by the first configure).
    refresh: () => beat.now(),
    options: () => resolve(plugin.options ?? {}, settings.options[plugin.id]) as never,
    setOptions: (patch) => saveOptions?.(plugin.id, patch),
    // Only the secrets it declares: not another plugin's.
    secret: async (key: string) => {
      if (plugin.options?.[key]?.kind !== "secret") throw new Error(`"${key}" isn't one of ${plugin.id}'s secret options`);
      return (await readSecret?.(plugin.id, key)) ?? "";
    },
    openSettings: () => openSettings?.(`widgets:${plugin.id}`),
    openPage: (params) => openSettings?.(pageTarget(plugin.id, params)),
    // The style actually drawing, which differs from the chosen one while that one is broken.
    appearance: () => appearance(),
    notify: (notice) => {
      const id = notices.post(sourceOf(plugin), toNotice(notice));
      return { id, update: (patch) => notices.update(id, patch), dismiss: () => notices.remove(id) };
    },
    on: (event, listener) => {
      const byEvent = listeners.get(plugin.id) ?? new Map<keyof HostEvents, Set<(payload: never) => void>>();
      listeners.set(plugin.id, byEvent);
      const set = byEvent.get(event) ?? new Set();
      byEvent.set(event, set);
      set.add(listener as (payload: never) => void);
      return () => void set.delete(listener as (payload: never) => void);
    },
  });
  const appearance = (): Appearance => ({
    style: style.id,
    size: settings.general.pillSize,
    theme: settings.general.theme,
    tone: isLight(settings.general.pillColor) ? "light" : "dark",
    notch: i.hasNotch,
  });
  const mounted = new Map<string, Mounted>();
  let placement: Placement = { left: [], right: [], tabs: [] };
  let active: Mounted[] = [];
  let view: Tabs | undefined;

  // The folded pill at the chosen size, the style that draws it, and the size that style folds to.
  let pill: Pill = pillOf(i, initial.general.pillSize);
  // Mounted by the first configure, before any plugin is set up or anything is drawn.
  let style!: AnyStyle;
  let folded = { width: pill.width, height: pill.height };
  /** Styles that failed this session: the island goes on with another one. */
  const broken = new Set<string>();
  /** Open, the island is at least as tall as the pill, so the panel sits the same under every style. */
  const openRow = () => Math.max(folded.height, pill.height);
  /** The panel height each tab's content was last measured to need: text wraps further in a wider font (Linux's). */
  const needs = new Map<string, number>();
  /** What a tab asks for, or more if its content needs it. */
  const askedBy = (m: Mounted) => Math.max(m.plugin.panelHeight ?? 0, needs.get(m.plugin.id) ?? 0);
  /** The open panel's height: what the shown tab asks for. */
  const panelNow = () => {
    const shown = placement.tabs.find((m) => m.plugin.id === view?.active());
    return panelHeight(shown && askedBy(shown));
  };
  const sized = (open: boolean, wide = false, panel = panelNow()) =>
    open ? sizeFor(true, { width: folded.width, height: openRow() }, false, 1, panel) : sizeFor(false, folded, wide && style?.widens !== false, pill.scale);
  /**
   * The window holds the open pill with its tallest tab, so switching tabs only moves the input
   * region; and room for bubbles when notifications show as bubbles (or a plugin's notifier).
   */
  const canvasNow = (): Size => {
    const opened = frame(sized(true, false, Math.max(panelNow(), ...placement.tabs.map((m) => panelHeight(askedBy(m))))), true, pill.scale);
    const { format, side } = settings.notifications;
    if (format === "pill" || format === "toast") return opened;
    const room = bubbleCanvas(side, sizeFor(false, folded, style?.widens !== false, pill.scale), pill.scale);
    return { width: Math.max(opened.width, room.width), height: Math.max(opened.height, room.height) };
  };
  /** Bubbles on screen, which take input too. */
  let extra: readonly Area[] = [];

  el.dataset.notch = String(i.hasNotch);
  el.dataset.open = "false";
  el.dataset.hidden = "false";
  let canvas = canvasNow();
  /**
   * Measures the shown tab's content; true when its panel needs another height than measured before.
   * Read from offsets, which the panel's open and close transforms don't change.
   */
  const measure = (): boolean => {
    const id = view?.active();
    const section = panel.querySelector<HTMLElement>(".panels > section:not([hidden])");
    const blocks = [...(section?.children ?? [])].filter((c): c is HTMLElement => c instanceof HTMLElement && c.offsetParent !== null);
    if (!id || !section || !blocks.length) return false;
    // A block may shrink to the room and let its content spill out (min-height: 0): that spill counts,
    // unless the block scrolls or clips it on purpose.
    const tall = (b: HTMLElement) => (/auto|scroll|hidden|clip/.test(getComputedStyle(b).overflowY) ? b.offsetHeight : Math.max(b.offsetHeight, b.scrollHeight));
    const content = Math.max(...blocks.map((b) => b.offsetTop + tall(b))) - Math.min(...blocks.map((b) => b.offsetTop));
    // The panel around the content (tabs, gaps, padding) stays; the room left for content becomes the content's height.
    const need = Math.ceil(panel.offsetHeight - section.clientHeight + content);
    if (need === needs.get(id)) return false;
    needs.set(id, need);
    return true;
  };
  /** Sizes the panel for the shown tab, laid out at its final size before the pill reveals it. */
  const fitPanel = () => {
    measure();
    el.style.setProperty("--panel-h", `${panelNow()}px`);
    canvas = canvasNow();
  };
  const reshape = () => {
    // Panel content is laid out once at its final size; the pill only reveals it, so nothing reflows mid-animation.
    el.style.setProperty("--panel-w", `${sized(true).width}px`);
    el.style.setProperty("--glance-h", `${folded.height}px`);
    el.style.setProperty("--glance-open-h", `${openRow()}px`);
    // Registered in CSS, so text, icons and ears ease to a new pill size along with the pill.
    el.style.setProperty("--scale", String(pill.scale));
    el.style.setProperty("--curve", String(settings.general.pillCurve / 100));
    const { theme, pillColor, accentColor } = settings.general;
    for (const [name, value] of Object.entries(palette(themeById(theme), pillColor, accentColor))) el.style.setProperty(name, value);
    el.dataset.tone = isLight(settings.general.pillColor) ? "light" : "dark";
    fitPanel();
  };
  let open = false;
  /** Set once the startup animation is over. */
  let started = false;
  /** False while a startup animation plays: the pill doesn't open meanwhile. */
  let ready = false;
  // A glance may widen the collapsed pill into a live activity (music, a volume change…), as does a notification shown in it.
  let wide = false;
  let noticeWide = false;
  /** Set once the pill has its first size on screen; size changes before that need no resizing. */
  let laidOut = false;

  // The style draws the folded island in here; startup animations hide it while they play.
  const glance = h("div", { class: "glance" });
  /** What a style draws before the first one is mounted, or when one fails to mount: nothing. */
  const NOTHING: StyleView = { draw() {} };
  let look: StyleView = NOTHING;
  const panel = h("div", { class: "panel" });
  const gear = openSettings && button(icon(GEAR), () => openSettings(), { class: "gear", "aria-label": "Settings", title: "Settings" });
  const power = quit && armedButton(POWER, quit, { label: "Quit AiN", armed: "Click again to quit AiN" }, "gear quit");
  const alerting = (now: number) => active.find((m) => m.widget.glance?.(now)?.tone === "alert");

  let shown: Size = { width: 0, height: 0 };
  const apply = (s: Size) => {
    shown = s;
    el.style.setProperty("--w", `${s.width}px`);
    el.style.setProperty("--h", `${s.height}px`);
  };

  /** Moves the pill to its current size: the input region grows before the pill does, and shrinks after. */
  const resize = async () => {
    const s = sized(open, wide);
    const grows = s.width > shown.width || s.height > shown.height;
    if (grows) await win.layout(canvas, frame(s, open, pill.scale), extra);
    apply(s);
    if (!grows) void win.layout(canvas, frame(s, open, pill.scale), extra);
  };

  /** Shows `next`'s look in place of the current one; it pops in once the island has started. */
  const mountLook = (next: AnyStyle) => {
    try {
      look.destroy?.();
    } catch (e) {
      console.error(`[island] pill style "${style?.id}": destroy failed: ${String(e)}`);
    }
    // A fresh root: nothing the last style added or set on it stays.
    glance.replaceChildren();
    glance.removeAttribute("style");
    glance.className = "glance";
    style = next;
    el.dataset.style = next.id;
    try {
      look = next.mount(glance, { options: () => styleOptions(next, settings.options) as never });
    } catch (e) {
      look = NOTHING;
      fail(next, "mount", e);
      return;
    }
    if (ready && !reducedMotion())
      glance.animate(
        [
          { opacity: 0, transform: "scale(0.9)", filter: "blur(4px)" },
          { opacity: 1, transform: "none", filter: "none" },
        ],
        { duration: 420, easing: EASE_OUT },
      );
  };

  /** The style picked, unless it failed: then the default, or a bare pill when every style failed. */
  const pickStyle = (): AnyStyle => {
    const working = styles.filter((s) => !broken.has(s.id));
    return working.length ? styleById(working, settings.general.style) : BARE;
  };

  /** Follows the settings' style and size: mounts a newly picked style, and resizes when the folded size changes. */
  function restyle() {
    const next = pickStyle();
    if (next !== style) mountLook(next);
    const current = style;
    pill = pillOf(i, settings.general.pillSize);
    const nextFolded = foldedSize(current, pill, styleOptions(current, settings.options));
    const changed = nextFolded.width !== folded.width || nextFolded.height !== folded.height;
    folded = nextFolded;
    reshape();
    if (started) autoHide();
    if (changed && laidOut) void resize();
  }

  /** A style that throws is set aside for the session, and the island carries on with another. */
  function fail(failed: AnyStyle, what: string, e: unknown) {
    console.error(`[island] pill style "${failed.id}": ${what} failed, so it was set aside: ${String(e)}`);
    if (failed === BARE) return;
    broken.add(failed.id);
    restyle();
  }

  const drawLook = (f: Folded) => {
    const drawn = style;
    try {
      look.draw(f);
    } catch (e) {
      fail(drawn, "draw", e);
    }
  };

  const beat = ticker(async () => {
    const now = Date.now();
    await Promise.allSettled(active.map((m) => m.widget.tick?.({ now, visible: open && m.plugin.id === view?.active() })));
    const dress = dressOf(settings);
    const lefts = pickAll(placement.left, now, settings.pill.perSide, dress);
    const rights = pickAll(placement.right, now, settings.pill.perSide, dress);
    const l = lefts[0];
    const r = rights[0];
    const alert = alerting(now) !== undefined;
    el.dataset.alert = String(alert);

    // Tint follows what's in focus: the open tab, or whoever speaks on the collapsed pill.
    const focus = open ? active.find((m) => m.plugin.id === view?.active()) : (r?.from ?? l?.from);
    const ambient = focus?.widget.ambient?.() ?? null;
    if (ambient) el.style.setProperty("--ambient", ambient);
    else el.style.removeProperty("--ambient");

    const nextWide = [...lefts, ...rights].some((s) => s.glance.wide) || noticeWide;
    drawLook({
      left: l?.glance ?? null,
      right: r?.glance ?? null,
      leftFrom: l?.from.plugin.id,
      rightFrom: r?.from.plugin.id,
      leftAll: lefts.map(spoken),
      rightAll: rights.map(spoken),
      ambient,
      alert,
      wide: nextWide,
      now,
    });
    // The open tab's content grew or shrank (a download's progress, a longer message): so does the panel.
    if (open && el.dataset.open === "true" && measure()) {
      fitPanel();
      await resize();
    }
    if (nextWide !== wide) {
      wide = nextWide;
      el.dataset.wide = String(wide);
      if (!open) await resize();
    }
  });

  // One preview at a time; asks made while one plays wait for it, and only the last one plays.
  let previews: Promise<void> = Promise.resolve();
  let asked = 0;
  const preview = (id?: string) => {
    if (!started) return;
    const turn = ++asked;
    previews = previews.then(async () => {
      if (turn !== asked || open) return;
      ready = false;
      await greet(el, { size: sized(false, wide), scale: pill.scale }, greetings, id ?? settings.general.greeting, !reducedMotion());
      ready = true;
    });
  };

  // A hidden style shows only once the cursor rests at the top center; once shown, it hides again
  // when the island has had time to close after the cursor left. Sent only when it changes.
  let rule = "";
  function autoHide() {
    const { revealDelay, closeDelay } = settings.general;
    const dwell = style?.hidden === true ? revealDelay : null;
    const grace = closeDelay + CLOSING;
    if (`${dwell}/${grace}` === rule) return;
    rule = `${dwell}/${grace}`;
    win.autoHide(dwell, grace).catch((e: unknown) => console.error("[island] could not set auto-hide", e));
  }

  /** Another tab is shown: the open island grows or shrinks to the panel it asks for. */
  const switched = () => {
    fitPanel();
    if (el.dataset.open === "true") void resize();
    beat.now();
  };

  const configure = (
    next: Settings,
    nextCatalogue?: readonly Plugin<S, Fields>[],
    nextGreetings?: readonly Greeting[],
    nextStyles?: readonly AnyStyle[],
    nextNotifiers?: readonly Notifier[],
  ) => {
    // Picking another startup animation in Settings plays it, as a preview.
    const replay = started && next.general.greeting !== settings.general.greeting;
    const before = { settings, appearance: style && JSON.stringify(appearance()), canvas: JSON.stringify(canvas) };
    settings = next;
    if (nextCatalogue) plugins = nextCatalogue;
    if (nextGreetings) greetings = nextGreetings;
    if (nextStyles) styles = nextStyles;
    if (nextNotifiers) notifiers = nextNotifiers;
    if (replay && !open) preview();
    i = shaped(hardware, next.general);
    restyle();
    const loaded = load(plugins, next.layout, services, hostFor, mounted);
    const placed = place(mounted, next.layout);
    for (const p of [...loaded.problems, ...placed.problems]) console.warn(`[island] ${p}`);
    placement = placed.placement;
    active = placedOnce(placement);
    view = tabs(placement.tabs, switched, view?.active());
    panel.replaceChildren(h("div", { class: "panel-head" }, view.bar, ...(gear ? [gear] : []), ...(power ? [power] : [])), view.panels);
    fitPanel();
    notices.configure(next.notifications);
    notices.setHooks(hooksOf(mounted));
    const { bg, fg, accent } = { bg: next.general.pillColor, ...colorsOf(next) };
    noted.configure(next.notifications, notifiers, { bg, fg, accent });
    if (el.dataset.open === "true") void resize();
    // Room for bubbles came or went: the window follows (it never does mid-animation otherwise).
    // The region covers the pill as shown and as it is becoming, should a resize still be under way.
    else if (laidOut && JSON.stringify(canvas) !== before.canvas) {
      const next = sized(false, wide);
      void win.layout(canvas, frame({ width: Math.max(shown.width, next.width), height: Math.max(shown.height, next.height) }, false, pill.scale), extra);
    }
    if (before.appearance !== undefined && JSON.stringify(appearance()) !== before.appearance) emit("appearance", appearance);
    for (const [id, m] of mounted)
      if (JSON.stringify(next.options[id]) !== JSON.stringify(before.settings.options[id])) tell(id, "options", resolve(m.plugin.options ?? {}, next.options[id]));
    beat.now();
  };

  const surface = h("div", { class: "surface" }, glance, panel);
  el.append(surface);
  const noted: NoticeView = noticeView(el, surface, notices, extras.toasts ?? noToasts, {
    widen: (on) => {
      noticeWide = on;
      beat.now();
    },
    regions: (rects) => {
      extra = rects.map(({ x, y, width, height }) => ({ x, y, width, height }));
      if (laidOut) void win.layout(canvas, frame(shown, open, pill.scale), extra);
    },
    unseen: (count) => emit("unseen", () => count),
  });
  notices.listen({
    action: (n, actionId) => {
      try {
        mounted.get(n.source.id)?.widget.onNotificationAction?.(n.id, actionId);
      } catch (e) {
        console.error(`[island] plugin "${n.source.id}": onNotificationAction failed: ${String(e)}`);
      }
    },
  });
  configure(initial);

  // Grow the input region before the pill animates out; shrink it only after the pill has animated in.
  const toggle = async (next: boolean) => {
    // Not while a startup animation plays: it drives the pill's size.
    if (next === open || (next && !ready)) return;
    open = next;
    noted.setOpen(open);
    emit("open", () => open);
    if (open) {
      // Opening on an alerting tab: the island opens to that tab's panel.
      const alert = alerting(Date.now());
      if (alert && placement.tabs.includes(alert) && alert.plugin.id !== view?.active()) view?.select(alert.plugin.id, false);
      // What the tab shows may have changed while the island was folded.
      fitPanel();
      const s = sized(true, wide);
      await win.layout(canvas, frame(s, true, pill.scale), extra);
      if (!open) return;
      el.dataset.open = "true";
      apply(s);
      beat.now();
      return;
    }
    const s = sized(false, wide);
    el.dataset.open = "false";
    apply(s);
    if (!animates(getComputedStyle(el).transitionDuration)) return win.layout(canvas, frame(s, false, pill.scale), extra);
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== "height") return;
      el.removeEventListener("transitionend", onEnd);
      // The size may have changed while it folded (a new style or pill size): use the current one.
      if (!open) void win.layout(canvas, frame(sized(false, wide), false, pill.scale), extra);
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

  apply(sized(false));
  await win.layout(canvas, frame(sized(false), false, pill.scale), extra);
  laidOut = true;

  beat.start();
  // The startup animation plays first; hovering (and auto-hiding) waits for it.
  void greet(el, { size: sized(false), scale: pill.scale }, greetings, settings.general.greeting, !reducedMotion()).then(() => {
    started = ready = true;
    autoHide();
    el.addEventListener("pointerenter", hover.enter);
    el.addEventListener("pointerleave", hover.leave);
    el.addEventListener("click", () => hover.set(true));
    document.documentElement.addEventListener("mouseleave", hover.leave);
    window.addEventListener("blur", () => hover.set(false));
  });
  const command = (id: string, kind: CommandKind) => {
    const dot = id.indexOf(".");
    const widget = mounted.get(id.slice(0, dot))?.widget;
    try {
      widget?.onCommand?.(id.slice(dot + 1), kind);
    } catch (e) {
      console.error(`[island] command "${id}" failed: ${String(e)}`);
    }
  };
  return { configure, play: (id) => preview(id), command };
}
