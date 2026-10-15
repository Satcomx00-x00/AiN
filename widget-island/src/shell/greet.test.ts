// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Greeting, Stage } from "../sdk/greeting";
import { NO_GREETING, greet } from "./greet";

function island() {
  const el = document.createElement("div");
  el.innerHTML = `<div class="surface"><div class="glance"></div></div>`;
  return el;
}

const SIZE = { width: 200, height: 32 };

/** A greeting that records the stages it was played on. */
function fake(id: string, play: (stage: Stage) => Promise<void> | void = () => {}) {
  const stages: Stage[] = [];
  const greeting: Greeting = {
    id,
    label: id,
    play: (stage) => {
      stages.push(stage);
      return play(stage);
    },
  };
  return { greeting, stages };
}

afterEach(() => vi.useRealTimers());

describe("greet", () => {
  it("plays the chosen greeting on the pill, its inside and its glances", async () => {
    const a = fake("one");
    const b = fake("two");
    const el = island();
    await greet(el, SIZE, [a.greeting, b.greeting], "two", true);
    expect(a.stages).toHaveLength(0);
    expect(b.stages).toEqual([{ island: el, surface: el.querySelector(".surface"), glance: el.querySelector(".glance"), size: SIZE }]);
  });

  it("plays nothing for “none”, or when motion should be reduced", async () => {
    const a = fake("one");
    await greet(island(), SIZE, [a.greeting], NO_GREETING, true);
    await greet(island(), SIZE, [a.greeting], "one", false);
    expect(a.stages).toHaveLength(0);
  });

  it("falls back to the first greeting when the chosen one is gone", async () => {
    const a = fake("one");
    const b = fake("two");
    await greet(island(), SIZE, [a.greeting, b.greeting], "removed-plugin", true);
    expect(a.stages).toHaveLength(1);
    expect(b.stages).toHaveLength(0);
  });

  it("does nothing without greetings or without the pill's inside", async () => {
    const a = fake("one");
    await expect(greet(island(), SIZE, [], "one", true)).resolves.toBeUndefined();
    await greet(document.createElement("div"), SIZE, [a.greeting], "one", true);
    expect(a.stages).toHaveLength(0);
  });

  it("waits for the greeting to end", async () => {
    let finish: () => void = () => {};
    const a = fake("one", () => new Promise<void>((r) => (finish = r)));
    let over = false;
    const done = greet(island(), SIZE, [a.greeting], "one", true).then(() => (over = true));
    await Promise.resolve();
    expect(over).toBe(false);
    finish();
    await done;
    expect(over).toBe(true);
  });

  it("goes on when a greeting fails, sync or async, and says why", async () => {
    const log = vi.fn();
    const sync = fake("sync", () => {
      throw new Error("boom");
    });
    const async = fake("async", () => Promise.reject(new Error("bang")));
    await expect(greet(island(), SIZE, [sync.greeting], "sync", true, log)).resolves.toBeUndefined();
    await expect(greet(island(), SIZE, [async.greeting], "async", true, log)).resolves.toBeUndefined();
    expect(log.mock.calls.map(([m]) => m)).toEqual([expect.stringMatching(/"sync" failed: Error: boom/), expect.stringMatching(/"async" failed: Error: bang/)]);
  });

  it("goes on without a greeting that runs past the limit", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const stuck = fake("stuck", () => new Promise<void>(() => {}));
    let over = false;
    const done = greet(island(), SIZE, [stuck.greeting], "stuck", true, log, 1000).then(() => (over = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(over).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/"stuck" ran past 1000 ms/));
  });

  it("leaves no timer behind once the greeting is done", async () => {
    vi.useFakeTimers();
    await greet(island(), SIZE, [fake("one").greeting], "one", true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
