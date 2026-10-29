/**
 * One notification as a card, the same in a bubble under the pill and in a corner toast. Built
 * for accessibility: a Close column a sixth of the card wide and as tall as it, text and buttons
 * large enough to read and hit, announced to screen readers (urgent ones at once), Escape closes
 * it, and its timer waits while the pointer or the keyboard is on it.
 */
import "./notice-card.css";
import { button, h, icon } from "../sdk/dom";
import type { Notification } from "../sdk/notify";

const CLOSE = `<path d="M4 4l8 8M12 4l-8 8"/>`;

export interface CardOptions {
  /** Actions shown as buttons. */
  readonly actions: boolean;
  readonly largeText: boolean;
  /** How long it shows before it leaves on its own, in ms; null until closed. */
  readonly lifetime: number | null;
  /** Shows the time left as a bar along the bottom. */
  readonly bar: boolean;
  /** "slide" | "fade" | "pop" | "drop" | "none", and from where a slide comes. */
  readonly animation: string;
  readonly from?: "left" | "right" | "top";
  /** Animation length, in ms. */
  readonly speed: number;
}

export interface CardEvents {
  /** The user closed it. */
  close(): void;
  act(actionId: string): void;
  /** Its time ran out. */
  expire(): void;
}

export interface Card {
  readonly el: HTMLElement;
  /** Shows a newer version of the same notification, its timer started again. */
  update(n: Notification): void;
  /** Animates out, then removes itself. */
  leave(): Promise<void>;
}

const ago = (n: Notification) => (Date.now() - n.at < 60_000 ? "now" : new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));

export function card(n: Notification, o: CardOptions, on: CardEvents): Card {
  const el = h("div", {
    class: `notice-card${o.largeText ? " large" : ""}`,
    role: n.urgency === "urgent" ? "alert" : "status",
    tabindex: "0",
    "data-anim": o.animation,
    "data-from": o.from ?? "top",
  });
  el.style.setProperty("--notice-ms", `${o.speed}ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let left = o.lifetime ?? 0;
  let started = 0;
  const bar = h("i", { class: "notice-bar", "aria-hidden": "true" });

  const draw = (m: Notification) => {
    const main = h(
      "div",
      { class: "notice-main" },
      h("span", { class: "notice-app", "aria-hidden": "true" }, icon(m.icon)),
      h(
        "span",
        { class: "notice-head" },
        h("b", { class: "notice-title" }, m.title),
        h("span", { class: "notice-src" }, `${m.source.label} · ${ago(m)}`, ...(m.urgency === "urgent" ? [" · ", h("strong", {}, "Urgent")] : [])),
      ),
      ...(m.body ? [h("span", { class: "notice-body" }, m.body)] : []),
    );
    // Beside the text, left of Close: the card stays two lines tall.
    const acts = o.actions && m.actions.length ? [h("div", { class: "notice-acts" }, ...m.actions.map((a) => button(a.label, () => on.act(a.id))))] : [];
    const close = button(h("span", {}, icon(CLOSE), h("span", { "aria-hidden": "true" }, "Close")), () => on.close(), {
      class: "notice-close",
      "aria-label": `Close notification: ${m.title}`,
    });
    el.replaceChildren(main, ...acts, close, ...(o.lifetime === null || !o.bar ? [] : [bar]));
  };

  // The timer and its bar pause together while the pointer or the keyboard is on the card.
  const run = () => {
    if (o.lifetime === null || left <= 0) return;
    started = Date.now();
    timer = setTimeout(on.expire, left);
    bar.style.animationPlayState = "running";
  };
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    left -= Date.now() - started;
    bar.style.animationPlayState = "paused";
  };
  const restart = () => {
    pause();
    left = o.lifetime ?? 0;
    bar.style.animation = "none";
    void bar.offsetWidth;
    bar.style.animation = "";
    bar.style.animationDuration = `${left}ms`;
    run();
  };
  const holding = () => el.matches(":hover, :focus-within");
  el.addEventListener("pointerenter", pause);
  el.addEventListener("pointerleave", () => holding() || run());
  el.addEventListener("focusin", pause);
  el.addEventListener("focusout", () => setTimeout(() => holding() || run()));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") on.close();
  });

  draw(n);
  restart();
  return {
    el,
    update(m) {
      draw(m);
      restart();
    },
    async leave() {
      pause();
      el.dataset.leaving = "true";
      if (o.animation === "none") return el.remove();
      await Promise.race([new Promise((r) => el.addEventListener("animationend", r, { once: true })), new Promise((r) => setTimeout(r, o.speed + 50))]);
      el.remove();
    },
  };
}
