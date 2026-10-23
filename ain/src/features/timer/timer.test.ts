// @vitest-environment happy-dom
/** The Timer tab: the ring, start/pause, reset, presets and +1m, and the state machine behind them. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { add, progress, remaining, timer, toggle } = await import(".");

const MIN = 60_000;
const NOW = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the countdown", () => {
  it("has nothing left once done, and no progress without a duration", () => {
    expect(remaining({ kind: "done", duration: MIN }, 0)).toBe(0);
    expect(progress({ kind: "idle", duration: 0 }, 0)).toBe(0);
  });

  it("goes back to its duration when a finished timer is dismissed", () => expect(toggle({ kind: "done", duration: MIN }, 0)).toEqual({ kind: "idle", duration: MIN }));

  it("adds time before starting and while paused, up to a day", () => {
    expect(add({ kind: "idle", duration: 5 * MIN }, MIN, 0)).toEqual({ kind: "idle", duration: 6 * MIN });
    expect(add({ kind: "idle", duration: 24 * 60 * MIN }, MIN, 0).duration).toBe(24 * 60 * MIN);
    expect(add({ kind: "paused", duration: 5 * MIN, left: 2 * MIN }, MIN, 0)).toEqual({ kind: "paused", duration: 6 * MIN, left: 3 * MIN });
  });
});

describe("the Timer tab", () => {
  const mount = () => {
    const widget = timer.setup(undefined, { refresh() {}, options: () => ({ minutes: 5 }), setOptions() {}, openSettings() {} } as never);
    const root = document.createElement("section");
    widget.panel?.(root);
    const tick = (now = Date.now()) => widget.tick?.({ now, visible: true });
    tick();
    const byText = (text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
    return {
      widget,
      root,
      tick,
      main: root.querySelector<HTMLButtonElement>(".round.primary")!,
      reset: root.querySelector<HTMLButtonElement>("[aria-label=Reset]")!,
      byText,
      time: () => root.querySelector(".ring-time")?.textContent,
      sub: () => root.querySelector(".ring-sub")?.textContent,
    };
  };

  it("starts ready at the starting duration, its preset pressed", () => {
    const t = mount();
    expect([t.time(), t.sub(), t.main.getAttribute("aria-label"), t.reset.disabled]).toEqual(["5:00", "ready", "Start", true]);
    expect(t.byText("5m").getAttribute("aria-pressed")).toBe("true");
  });

  it("picks a preset, adds a minute, and counts down once started", () => {
    const t = mount();
    t.byText("10m").click();
    t.byText("+1m").click();
    expect([t.time(), t.byText("10m").getAttribute("aria-pressed")]).toEqual(["11:00", "false"]);
    t.main.click();
    expect([t.main.getAttribute("aria-label"), t.sub()]).toEqual(["Pause", "of 11:00"]);
    vi.setSystemTime(NOW + MIN);
    t.tick();
    expect(t.time()).toBe("10:00");
    t.main.click();
    expect([t.main.getAttribute("aria-label"), t.widget.glance?.(Date.now())?.tone]).toEqual(["Resume", "muted"]);
  });

  it("says when time is up, then resets to the same duration", () => {
    const t = mount();
    t.byText("1m").click();
    t.main.click();
    t.tick(NOW + MIN);
    expect([t.time(), t.sub(), t.main.getAttribute("aria-label"), t.reset.disabled]).toEqual(["Done", "1:00 up", "Dismiss", false]);
    t.reset.click();
    expect([t.time(), t.sub(), t.reset.disabled]).toEqual(["1:00", "ready", true]);
  });

  it("keeps counting while hidden, without redrawing", () => {
    const t = mount();
    t.main.click();
    t.widget.tick?.({ now: NOW + 5 * MIN, visible: false });
    expect(t.time()).toBe("5:00");
    expect(t.widget.glance?.(NOW + 5 * MIN)?.text).toBe("Done");
  });
});
