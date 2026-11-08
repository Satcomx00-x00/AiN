import { afterEach, describe, expect, it, vi } from "vitest";
import { intent } from "./intent";

afterEach(() => vi.useRealTimers());

describe("intent", () => {
  it("opens after the open delay, and only the latest request wins", async () => {
    vi.useFakeTimers();
    const applied: boolean[] = [];
    const h = intent((o) => applied.push(o), () => false, () => ({ open: 100, close: 50 }));
    h.enter();
    await vi.advanceTimersByTimeAsync(99);
    expect(applied).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(applied).toEqual([true]);
    h.leave();
    await vi.advanceTimersByTimeAsync(50);
    expect(applied).toEqual([true, false]);
  });

  it("opens at once while open, and a leave after an enter supersedes it", async () => {
    vi.useFakeTimers();
    const applied: boolean[] = [];
    const h = intent((o) => applied.push(o), () => true, () => ({ open: 100, close: 50 }));
    h.enter();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([true]);
    h.enter();
    h.leave();
    await vi.advanceTimersByTimeAsync(50);
    expect(applied).toEqual([true, false]);
  });

  it("sets a state at once, cancelling what was pending", async () => {
    vi.useFakeTimers();
    const applied: boolean[] = [];
    const h = intent((o) => applied.push(o), () => false, () => ({ open: 100, close: 50 }));
    h.enter();
    h.set(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(applied).toEqual([false]);
  });

  it("cancels a change still waiting", async () => {
    vi.useFakeTimers();
    const applied: boolean[] = [];
    const h = intent((o) => applied.push(o), () => true, () => ({ open: 100, close: 50 }));
    h.leave();
    h.cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(applied).toEqual([]);
  });
});
