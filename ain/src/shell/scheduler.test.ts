import { afterEach, describe, expect, it, vi } from "vitest";
import { ticker } from "./scheduler";

afterEach(() => vi.useRealTimers());

describe("ticker", () => {
  it("runs at once on start, then just after each wall-clock second", async () => {
    vi.useFakeTimers({ now: 10_500 });
    const task = vi.fn(async () => {});
    const beat = ticker(task);
    beat.start();
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(507);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(3);
    beat.stop();
  });

  it("runs on demand outside the beat, and not at all once stopped", async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => {});
    const beat = ticker(task);
    beat.now();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    beat.start();
    await vi.advanceTimersByTimeAsync(0);
    beat.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("stays stopped when the task stops it, even though the next beat was already due", async () => {
    vi.useFakeTimers();
    let beat: ReturnType<typeof ticker> | undefined;
    const task = vi.fn(async () => beat?.stop());
    beat = ticker(task);
    beat.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
