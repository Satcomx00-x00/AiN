import { button, h, icon, roll, svg } from "../core/dom";
import { number } from "../core/options";
import { type Glance, definePlugin } from "../core/plugin";

export type TimerState =
  | { kind: "idle"; duration: number }
  | { kind: "running"; duration: number; endsAt: number }
  | { kind: "paused"; duration: number; left: number }
  | { kind: "done"; duration: number };

const MIN = 60_000;
const MAX = 24 * 60 * MIN;
const PRESETS = [1, 5, 10, 25] as const;

const PLAY = `<path d="M5.25 3.4v9.2a.6.6 0 0 0 .9.5l7.3-4.6a.6.6 0 0 0 0-1L6.15 2.9a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none"/>`;
const PAUSE = `<path d="M5.5 3.5v9M10.5 3.5v9" stroke-width="2.25"/>`;
const RESET = `<path d="M3.25 8a4.75 4.75 0 1 0 1.4-3.36M3.25 2.75v2.5h2.5"/>`;
const CHECK = `<path d="M3.5 8.5l3 3 6-7" stroke-width="2"/>`;

const MAIN: Record<TimerState["kind"], readonly [icon: string, label: string]> = {
  idle: [PLAY, "Start"],
  paused: [PLAY, "Resume"],
  running: [PAUSE, "Pause"],
  done: [CHECK, "Dismiss"],
};

export const remaining = (s: TimerState, now: number): number =>
  s.kind === "running" ? Math.max(0, s.endsAt - now) : s.kind === "paused" ? s.left : s.kind === "idle" ? s.duration : 0;

export const progress = (s: TimerState, now: number): number =>
  s.kind === "done" ? 1 : s.duration ? 1 - remaining(s, now) / s.duration : 0;

export const settle = (s: TimerState, now: number): TimerState =>
  s.kind === "running" && s.endsAt <= now ? { kind: "done", duration: s.duration } : s;

export const toggle = (s: TimerState, now: number): TimerState => {
  switch (s.kind) {
    case "idle":
      return s.duration > 0 ? { kind: "running", duration: s.duration, endsAt: now + s.duration } : s;
    case "paused":
      return { kind: "running", duration: s.duration, endsAt: now + s.left };
    case "running":
      return { kind: "paused", duration: s.duration, left: remaining(s, now) };
    case "done":
      return { kind: "idle", duration: s.duration };
  }
};

export const add = (s: TimerState, ms: number, now: number): TimerState => {
  switch (s.kind) {
    case "idle":
      return { ...s, duration: Math.min(MAX, s.duration + ms) };
    case "running":
      return { ...s, duration: s.duration + ms, endsAt: Math.min(now + MAX, s.endsAt + ms) };
    case "paused":
      return { ...s, duration: s.duration + ms, left: Math.min(MAX, s.left + ms) };
    case "done":
      return { kind: "idle", duration: ms };
  }
};

export const fmt = (ms: number): string => {
  const t = Math.ceil(ms / 1000);
  const [hr, min, sec] = [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return hr > 0 ? `${hr}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
};

export const glanceOf = (s: TimerState, now: number): Glance | null => {
  switch (s.kind) {
    case "idle":
      return null;
    case "done":
      return { text: "Done", progress: 1, tone: "alert" };
    case "paused":
      return { text: fmt(s.left), progress: progress(s, now), tone: "muted" };
    case "running":
      return { text: fmt(remaining(s, now)), progress: progress(s, now) };
  }
};

export const timer = definePlugin({
  id: "timer",
  label: "Timer",
  description: "A countdown with presets; shows on the pill while it runs.",
  icon: `<circle cx="8" cy="9" r="5.25"/><path d="M8 9V6.5M6.5 1.75h3M12.25 4.25l1-1"/>`,
  slots: ["glance", "tab"],
  options: {
    minutes: number("Starting duration", 5, { min: 1, max: 180, unit: "min" }),
  },
  setup(_: unknown, host) {
    let state: TimerState = { kind: "idle", duration: host.options().minutes * MIN };
    const time = h("span", { class: "ring-time" });
    const sub = h("span", { class: "ring-sub" });
    const ring = h(
      "div",
      { class: "ring" },
      svg("0 0 88 88", `<circle class="track" cx="44" cy="44" r="40" pathLength="100"/><circle class="fill" cx="44" cy="44" r="40" pathLength="100"/>`),
      h("div", { class: "ring-label" }, time, sub),
    );
    const main = button("", () => set(toggle(state, Date.now())), { class: "round primary" });
    const reset = button(icon(RESET), () => set({ kind: "idle", duration: state.duration }), { class: "round", "aria-label": "Reset" });
    const chips = PRESETS.map((m) => ({ m, b: button(`${m}m`, () => set({ kind: "idle", duration: m * MIN }), { class: "chip" }) }));
    const plus = button("+1m", () => set(add(state, MIN, Date.now())), { class: "chip" });
    let mainIcon = "";

    const draw = (now: number) => {
      ring.dataset.state = state.kind;
      ring.style.setProperty("--p", String(progress(state, now)));
      roll(time, state.kind === "done" ? "Done" : fmt(remaining(state, now)));
      sub.textContent = state.kind === "idle" ? "ready" : state.kind === "done" ? `${fmt(state.duration)} up` : `of ${fmt(state.duration)}`;
      const [markup, label] = MAIN[state.kind];
      if (markup !== mainIcon) main.replaceChildren(icon(markup));
      mainIcon = markup;
      main.setAttribute("aria-label", label);
      main.dataset.state = state.kind;
      reset.disabled = state.kind === "idle";
      for (const { m, b } of chips) b.setAttribute("aria-pressed", String(state.kind === "idle" && state.duration === m * MIN));
    };

    const set = (next: TimerState) => {
      state = next;
      draw(Date.now());
    };

    return {
      panel: (root) =>
        root.append(
          h(
            "div",
            { class: "timer" },
            ring,
            h("div", { class: "timer-controls" }, h("div", { class: "row gap" }, main, reset), h("div", { class: "row gap wrap" }, ...chips.map((c) => c.b), plus)),
          ),
        ),
      tick({ visible, now }) {
        state = settle(state, now);
        if (visible) draw(now);
      },
      glance: (now) => glanceOf(state, now),
    };
  },
});
