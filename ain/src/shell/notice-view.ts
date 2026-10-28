/**
 * How the island shows notifications: the white dot left of the pill's glances while some are
 * unseen, and each notification in the format the user picked: in the pill itself, as a bubble
 * under or beside it, as a toast in a corner of the screen (its own window), or as a notifier
 * from a plugin file (drawn where the bubble goes).
 */
import { h, icon } from "../sdk/dom";
import type { Notification, Notifier } from "../sdk/notify";
import { type Card, card } from "./notice-card";
import { type Center, DEFAULT_NOTIFICATIONS, type NotificationSettings, SPEED_MS } from "./notifications";

/** Most bubbles at once: the island's window has room for three under the pill. */
export const MAX_BUBBLES = 3;

/** A rectangle in the island window, in px from its top left. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Colors the cards take: the pill's. */
export interface Colors {
  readonly bg: string;
  readonly fg: string;
  readonly accent: string;
}

export interface ToastSync {
  /** Oldest first. */
  readonly notices: readonly Notification[];
  readonly settings: NotificationSettings;
  readonly colors: Colors;
}

export type ToastEvent = { readonly kind: "close" | "expire"; readonly id: string } | { readonly kind: "act"; readonly id: string; readonly action: string };

/** The corner window that shows toasts. */
export interface ToastPort {
  /** Shows exactly these toasts (none hides the window). */
  sync(state: ToastSync): Promise<void>;
  /** What the user did with them; returns how to stop. */
  listen(onEvent: (e: ToastEvent) => void): Promise<() => void>;
}

/** No toast window, for previews and tests: toasts show nowhere and expire at once. */
export const noToasts: ToastPort = { sync: async () => {}, listen: async () => () => {} };

export interface ViewHooks {
  /** A notification shows in the pill: widen it (true), or it is over (false). */
  widen(on: boolean): void;
  /** Where bubbles take input now, besides the pill. */
  regions(rects: readonly Rect[]): void;
  /** The unseen count changed. */
  unseen?(count: number): void;
}

export interface NoticeView {
  configure(settings: NotificationSettings, notifiers: readonly Notifier[], colors: Colors): void;
  /** The island opened or folded: bubbles and the pill's notification step aside while open. */
  setOpen(open: boolean): void;
  destroy(): void;
}

const lifetime = (s: NotificationSettings): number | null => (s.sticky ? null : s.seconds * 1000);

export function noticeView(island: HTMLElement, surface: HTMLElement, c: Center, toasts: ToastPort, hooks: ViewHooks, log: (m: string) => void = console.warn): NoticeView {
  let settings: NotificationSettings = DEFAULT_NOTIFICATIONS;
  let configured = false;
  let notifiers: readonly Notifier[] = [];
  let colors: Colors = { bg: "#000000", fg: "#f5f5f7", accent: "#0a84ff" };
  let open = false;

  // ---- the dot ----
  const dot = h("span", { class: "unseen-dot", role: "img" });
  surface.prepend(dot);
  const stopWatch = c.watch((history) => {
    const unseen = history.filter((n) => !n.seen).length;
    island.dataset.unseen = String(unseen > 0);
    dot.setAttribute("aria-label", `${unseen} unseen notification${unseen === 1 ? "" : "s"}`);
    hooks.unseen?.(unseen);
  });

  // ---- in the pill ----
  const inline = h("div", { class: "notice-inline", "aria-live": "polite" });
  surface.append(inline);
  const queue: Notification[] = [];
  let inlineShown: Notification | null = null;
  let inlineTimer: ReturnType<typeof setTimeout> | undefined;
  const drawInline = (n: Notification) => {
    inline.replaceChildren(
      h("span", { class: "notice-inline-app", "aria-hidden": "true" }, icon(n.icon)),
      h("span", { class: "notice-inline-text" }, h("b", {}, n.title), ...(n.body ? [h("span", {}, n.body)] : [])),
    );
  };
  const nextInline = () => {
    clearTimeout(inlineTimer);
    if (inlineShown) c.expire(inlineShown.id);
    inlineShown = queue.shift() ?? null;
    island.dataset.notice = String(inlineShown !== null);
    hooks.widen(inlineShown !== null);
    if (!inlineShown) return inline.replaceChildren();
    drawInline(inlineShown);
    const ms = lifetime(settings);
    // Kept until the island opens, when it is to stay until seen.
    if (ms !== null) inlineTimer = setTimeout(nextInline, ms);
  };

  // ---- bubbles (and notifiers) ----
  const bubbles = h("div", { class: "bubbles", role: "region", "aria-label": "Notifications" });
  island.append(bubbles);
  const shownBubbles = new Map<string, { card: Card | null; stop: () => void; timer?: ReturnType<typeof setTimeout> }>();
  const report = () =>
    requestAnimationFrame(() => {
      if (open || !shownBubbles.size) return hooks.regions([]);
      const r = bubbles.getBoundingClientRect();
      hooks.regions(r.width && r.height ? [{ x: r.left, y: r.top, width: r.width, height: r.height }] : []);
    });
  const dropBubble = async (id: string) => {
    const b = shownBubbles.get(id);
    if (!b) return;
    shownBubbles.delete(id);
    clearTimeout(b.timer);
    await (b.card ? b.card.leave() : Promise.resolve(b.stop()));
    report();
  };
  /** Its time ran out (or a notifier dismissed it): off the screen; a transient one is forgotten. */
  const expire = (id: string) => {
    c.expire(id);
    return dropBubble(id);
  };
  const notifier = () => notifiers.find((x) => x.id === settings.format);
  const showBubble = (n: Notification) => {
    const s = settings;
    const custom = notifier();
    if (custom) {
      const stage = h("div", { class: "notifier-stage" });
      bubbles.prepend(stage);
      let cleanup: (() => void) | void;
      try {
        cleanup = custom.show(stage, n, { dismiss: () => void expire(n.id), act: (a) => c.act(n.id, a) });
      } catch (e) {
        log(`[notifications] notifier "${custom.id}" failed: ${String(e)}`);
      }
      const stop = () => {
        try {
          cleanup?.();
        } catch (e) {
          log(`[notifications] notifier "${custom.id}" cleanup failed: ${String(e)}`);
        }
        stage.remove();
      };
      const ms = lifetime(s);
      shownBubbles.set(n.id, { card: null, stop, ...(ms !== null ? { timer: setTimeout(() => void expire(n.id), ms) } : {}) });
    } else {
      const side = s.side;
      const animation = s.animation === "slide" ? (side === "center" ? "drop" : "slide") : s.animation;
      const made = card(
        n,
        { actions: s.actions, largeText: s.largeText, lifetime: lifetime(s), bar: s.bar, animation, from: side === "left" ? "right" : side === "right" ? "left" : "top", speed: SPEED_MS[s.speed] },
        { close: () => c.close(n.id), act: (a) => c.act(n.id, a), expire: () => void expire(n.id) },
      );
      bubbles.prepend(made.el);
      shownBubbles.set(n.id, { card: made, stop: () => made.el.remove() });
    }
    [...shownBubbles.keys()].slice(0, -Math.min(s.max, MAX_BUBBLES)).forEach((id) => void dropBubble(id));
    report();
  };

  // ---- toasts ----
  let toastList: Notification[] = [];
  const syncToasts = () => {
    void toasts.sync({ notices: toastList, settings, colors }).catch((e: unknown) => log(`[notifications] toasts: ${String(e)}`));
  };
  const dropToast = (id: string) => {
    if (!toastList.some((t) => t.id === id)) return;
    toastList = toastList.filter((t) => t.id !== id);
    syncToasts();
  };
  let stopToasts: (() => void) | undefined;
  void toasts
    .listen((e) => {
      if (e.kind === "act") c.act(e.id, e.action);
      else if (e.kind === "close") c.close(e.id);
      else c.expire(e.id);
      dropToast(e.id);
    })
    .then(
      (stop) => (stopToasts = stop),
      (e: unknown) => log(`[notifications] toasts: ${String(e)}`),
    );

  // ---- routing ----
  const format = () => (notifier() ? "notifier" : settings.format);
  const stopListen = c.listen({
    show(n) {
      const f = format();
      if (f === "pill") {
        queue.push(n);
        if (!inlineShown) nextInline();
      } else if (f === "toast") {
        toastList = [...toastList.filter((t) => t.id !== n.id), n].slice(-settings.max);
        syncToasts();
      } else showBubble(n);
    },
    update(n) {
      if (inlineShown?.id === n.id) {
        inlineShown = n;
        drawInline(n);
      }
      shownBubbles.get(n.id)?.card?.update(n);
      if (toastList.some((t) => t.id === n.id)) {
        toastList = toastList.map((t) => (t.id === n.id ? n : t));
        syncToasts();
      }
    },
    gone(id) {
      const i = queue.findIndex((q) => q.id === id);
      if (i >= 0) queue.splice(i, 1);
      if (inlineShown?.id === id) nextInline();
      void dropBubble(id);
      dropToast(id);
    },
  });

  return {
    configure(next, nextNotifiers, nextColors) {
      const moved = configured && (settings.format !== next.format || settings.side !== next.side || settings.corner !== next.corner);
      settings = next;
      configured = true;
      notifiers = nextNotifiers;
      colors = nextColors;
      bubbles.dataset.side = next.side;
      island.style.setProperty("--nc-anim", `${SPEED_MS[next.speed]}ms`);
      // Another format or place: what shows now leaves rather than jump.
      if (moved) {
        [...shownBubbles.keys()].forEach((id) => void dropBubble(id));
        toastList = [];
      }
      syncToasts();
    },
    setOpen(next) {
      open = next;
      // Opening the island is looking at it: what the pill was showing is seen.
      if (open && inlineShown) {
        c.close(inlineShown.id);
      }
      report();
    },
    destroy() {
      stopWatch();
      stopListen();
      stopToasts?.();
      clearTimeout(inlineTimer);
      [...shownBubbles.values()].forEach((b) => (clearTimeout(b.timer), b.stop()));
      dot.remove();
      inline.remove();
      bubbles.remove();
    },
  };
}
