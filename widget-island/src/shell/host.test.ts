// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Greeting } from "../sdk/greeting";
import { mount } from "./host";
import { type Settings, defaults } from "./settings";
import type { WindowPort } from "./window";

const EMPTY = { glance: { left: [], right: [] }, tabs: [] };
const settings = (greeting: string): Settings => {
  const base = defaults(EMPTY as never);
  return { ...base, general: { ...base.general, greeting } };
};
/** A window that records the auto-hide rules it is sent, and can show or hide the pill on cue. */
function fakeWindow() {
  const rules: [number | null, number][] = [];
  let reveal: (shown: boolean) => void = () => {};
  const port: WindowPort = {
    island: async () => ({ width: 200, height: 32, hasNotch: false }),
    layout: async () => {},
    autoHide: async (dwell, grace) => void rules.push([dwell, grace]),
    onReveal: async (onReveal) => ((reveal = onReveal), () => {}),
  };
  return { port, rules, reveal: (shown: boolean) => reveal(shown) };
}
let win = fakeWindow();

/** A greeting that records its plays and ends when told to. */
function controlled(id: string) {
  const plays: (() => void)[] = [];
  const greeting: Greeting = { id, label: id, play: () => new Promise<void>((r) => plays.push(r)) };
  return { greeting, plays, finish: () => plays.at(-1)?.() };
}

/** Lets every pending promise chain run. */
const settleAll = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

async function start(chosen: string | Settings, ...gs: Greeting[]) {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  const el = document.createElement("div");
  document.body.replaceChildren(el);
  win = fakeWindow();
  const handle = await mount(el, [], {}, win.port, typeof chosen === "string" ? settings(chosen) : chosen, { greetings: gs });
  return { el, handle };
}

describe("the island's startup animation", () => {
  it("plays the chosen one at startup, and the pill doesn't open before it's over", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const { el } = await start("two", a.greeting, b.greeting);
    expect([a.plays.length, b.plays.length]).toEqual([0, 1]);
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("false");
    b.finish();
    await settleAll();
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("true");
  });

  it("plays again, as a preview, when another one is picked", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const { handle } = await start("one", a.greeting, b.greeting);
    a.finish();
    await settleAll();
    handle.configure(settings("one"));
    await settleAll();
    expect(a.plays).toHaveLength(1);
    handle.configure(settings("two"));
    await settleAll();
    expect(b.plays).toHaveLength(1);
  });

  it("doesn't open while a preview plays", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const { el, handle } = await start("one", a.greeting, b.greeting);
    a.finish();
    await settleAll();
    handle.configure(settings("two"));
    await settleAll();
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("false");
    b.finish();
    await settleAll();
    el.dispatchEvent(new MouseEvent("pointerleave"));
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("true");
  });

  it("doesn't preview before the startup one is over", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const { handle } = await start("one", a.greeting, b.greeting);
    handle.configure(settings("two"));
    await settleAll();
    expect(b.plays).toHaveLength(0);
  });

  it("plays only the last of several quick picks, after the one playing", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const c = controlled("three");
    const { handle } = await start("one", a.greeting, b.greeting, c.greeting);
    a.finish();
    await settleAll();
    handle.configure(settings("two"));
    await settleAll();
    handle.configure(settings("three"));
    handle.configure(settings("one"));
    handle.configure(settings("three"));
    await settleAll();
    expect([a.plays.length, b.plays.length, c.plays.length]).toEqual([1, 1, 0]);
    b.finish();
    await settleAll();
    expect([a.plays.length, b.plays.length, c.plays.length]).toEqual([1, 1, 1]);
  });

  it("plays the animation asked for by id (the Play button), without changing the setting", async () => {
    const a = controlled("one");
    const b = controlled("two");
    const { handle } = await start("one", a.greeting, b.greeting);
    a.finish();
    await settleAll();
    handle.play("two");
    await settleAll();
    expect([a.plays.length, b.plays.length]).toEqual([1, 1]);
    b.finish();
    await settleAll();
    handle.play();
    await settleAll();
    expect([a.plays.length, b.plays.length]).toEqual([2, 1]);
  });

  it("plays the same animation again each time it's asked", async () => {
    const a = controlled("one");
    const { handle } = await start("one", a.greeting);
    for (let n = 0; n < 2; n++) {
      a.finish();
      await settleAll();
      handle.play("one");
      await settleAll();
    }
    expect(a.plays).toHaveLength(3);
  });

  it("ignores Play while the startup one is still on, or for “none”", async () => {
    const a = controlled("one");
    const { handle } = await start("one", a.greeting);
    handle.play("one");
    await settleAll();
    expect(a.plays).toHaveLength(1);
    a.finish();
    await settleAll();
    handle.play("none");
    await settleAll();
    expect(a.plays).toHaveLength(1);
  });

  it("doesn't play over the open panel", async () => {
    const a = controlled("one");
    const { el, handle } = await start("one", a.greeting);
    a.finish();
    await settleAll();
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("true");
    handle.play("one");
    await settleAll();
    expect(a.plays).toHaveLength(1);
  });

  it("previews from the animations given with the settings, e.g. once a plugin's is loaded", async () => {
    const a = controlled("one");
    const late = controlled("late");
    const { handle } = await start("one", a.greeting);
    a.finish();
    await settleAll();
    handle.configure(settings("late"), undefined, [a.greeting, late.greeting]);
    await settleAll();
    expect(late.plays).toHaveLength(1);
  });
});

describe("the hidden pill", () => {
  const hiding = (on: boolean, revealDelay = 500): Settings => {
    const base = settings("one");
    return { ...base, general: { ...base.general, autoHide: on, revealDelay } };
  };

  it("starts hiding only once the startup animation is over", async () => {
    const a = controlled("one");
    await start(hiding(true), a.greeting);
    expect(win.rules).toEqual([]);
    a.finish();
    await settleAll();
    expect(win.rules).toEqual([[500, 260 + 500]]);
  });

  it("sends the rule again only when it changes, and none when turned off", async () => {
    const a = controlled("one");
    const { handle } = await start(hiding(true), a.greeting);
    a.finish();
    await settleAll();
    handle.configure(hiding(true));
    handle.configure(hiding(true, 1000));
    handle.configure(hiding(false));
    expect(win.rules).toEqual([
      [500, 760],
      [1000, 760],
      [null, 760],
    ]);
  });

  it("fades out when hidden, closing the island, and comes back when shown", async () => {
    const a = controlled("one");
    const { el } = await start(hiding(true), a.greeting);
    a.finish();
    await settleAll();
    el.dispatchEvent(new MouseEvent("click"));
    await settleAll();
    expect(el.dataset.open).toBe("true");
    win.reveal(false);
    await settleAll();
    expect([el.dataset.hidden, el.dataset.open]).toEqual(["true", "false"]);
    win.reveal(true);
    expect(el.dataset.hidden).toBe("false");
  });
});
