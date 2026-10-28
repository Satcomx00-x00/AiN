/**
 * The corner toast window's page: the toasts the island sends, stacked from the screen's edge
 * (newest nearest it), the window sized to them and kept in its corner.
 */
import type { Notification } from "../../../sdk/notify";
import { type Card, card } from "../../notice-card";
import type { Corner } from "../../notifications";
import { SPEED_MS } from "../../notifications";
import type { ToastEvent, ToastSync } from "../../notice-view";

/** Width of a toast, in logical px; room is left around it for its shadow. */
export const TOAST_WIDTH = 300;
export const GUTTER = 12;

export interface ToastWindowPort {
  /** Sizes the window and keeps it in `corner`; a height of 0 hides it. */
  place(corner: Corner, width: number, height: number): Promise<void>;
  /** Tells the island what the user did. */
  send(e: ToastEvent): void;
}

export interface ToastStack {
  sync(state: ToastSync): void;
}

export function toastStack(root: HTMLElement, port: ToastWindowPort, log: (m: string) => void = console.warn): ToastStack {
  const shown = new Map<string, Card>();
  let corner: Corner = "top-right";

  const fit = () =>
    requestAnimationFrame(() => {
      const height = shown.size ? Math.ceil(root.scrollHeight) : 0;
      port.place(corner, TOAST_WIDTH + 2 * GUTTER, height).catch((e: unknown) => log(`[toasts] place: ${String(e)}`));
    });

  const drop = async (id: string, c: Card) => {
    shown.delete(id);
    await c.leave();
    fit();
  };

  return {
    sync({ notices, settings, colors }) {
      corner = settings.corner;
      const bottom = corner.startsWith("bottom");
      root.dataset.corner = corner;
      root.style.setProperty("--nc-bg", colors.bg);
      root.style.setProperty("--nc-fg", colors.fg);
      root.style.setProperty("--nc-focus", colors.accent);
      const ids = new Set(notices.map((n) => n.id));
      [...shown].filter(([id]) => !ids.has(id)).forEach(([id, c]) => void drop(id, c));
      const from = corner.endsWith("left") ? "left" : "right";
      const lifetime = settings.sticky ? null : settings.seconds * 1000;
      notices.forEach((n: Notification) => {
        const had = shown.get(n.id);
        if (had) return had.update(n);
        const made = card(
          n,
          { actions: settings.actions, largeText: settings.largeText, lifetime, bar: settings.bar, animation: settings.animation, from, speed: SPEED_MS[settings.speed] },
          {
            close: () => port.send({ kind: "close", id: n.id }),
            act: (action) => port.send({ kind: "act", id: n.id, action }),
            expire: () => port.send({ kind: "expire", id: n.id }),
          },
        );
        // Newest nearest the screen's edge: at the top in a top corner, at the bottom in a bottom one.
        if (bottom) root.append(made.el);
        else root.prepend(made.el);
        shown.set(n.id, made);
      });
      fit();
    },
  };
}
