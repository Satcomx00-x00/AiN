// @vitest-environment happy-dom
/** The Stats tab and glance: CPU, memory and network from the latest sample, and the CPU curve. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOTS } from "../../sdk/chart";
import type { Stats, StatsPort } from "./service";

const { stats } = await import(".");

const GB = 1024 ** 3;
const sample = (sampledAt: number, extra: Partial<Stats> = {}): Stats => ({ cpu: 40, memUsed: 4 * GB, memTotal: 16 * GB, rxPerSec: 1536, txPerSec: 512, sampledAt, ...extra });

beforeEach(() => vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList));
afterEach(() => vi.restoreAllMocks());

/** The tab on a fake backend serving `next` as the latest sample. */
function tab(show = "cpu") {
  let next: Stats | null = null;
  const port: StatsPort = { stats: async () => next };
  const widget = stats.setup({ stats: port }, { refresh() {}, options: () => ({ show }), setOptions() {}, openSettings() {} } as never);
  const root = document.createElement("section");
  widget.panel?.(root);
  const tick = async (s: Stats | null, visible = true) => {
    next = s;
    await widget.tick?.({ now: 0, visible });
  };
  const stat = (label: string) => [...root.querySelectorAll<HTMLElement>(".stat")].find((r) => r.querySelector(".eyebrow")?.textContent === label)!;
  return { root, widget, tick, stat, line: () => root.querySelector(".spark-line")?.getAttribute("d") };
}

describe("the Stats tab", () => {
  it("shows load, memory and network from the latest sample", async () => {
    const t = tab();
    await t.tick(sample(1, { cpu: 90 }));
    expect([t.stat("CPU").querySelector(".value")?.textContent, t.stat("CPU").querySelector<HTMLElement>(".bar")?.dataset.level]).toEqual(["90%", "hot"]);
    expect([t.stat("RAM").querySelector(".value")?.textContent, t.stat("RAM").querySelector<HTMLElement>(".bar")?.style.getPropertyValue("--p")]).toEqual(["4.0 GB / 16 GB", "0.25"]);
    expect(t.stat("NET").textContent).toBe("NET↓ 1.5 KB/s↑ 512 B/s");
    expect(t.line()).toMatch(/^M/);
  });

  it("waits for the first sample, and draws nothing while hidden", async () => {
    const t = tab();
    await t.tick(null);
    expect(t.stat("CPU").querySelector(".value")?.textContent).toBe("");
    await t.tick(sample(1), false);
    expect(t.stat("CPU").querySelector(".value")?.textContent).toBe("");
    expect(t.widget.glance?.(0)).toEqual({ text: "40%", spark: [40] });
  });

  it("redraws the curve only for a new sample, gliding it along unless motion is reduced", async () => {
    const t = tab();
    await t.tick(sample(1));
    const animate = vi.spyOn(Element.prototype, "animate").mockReturnValue({} as Animation);
    vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
    await t.tick(sample(2, { cpu: 80 }));
    const after = t.line();
    expect(animate).toHaveBeenCalledOnce();
    await t.tick(sample(2, { cpu: 80 }));
    expect([animate.mock.calls.length, t.line()]).toEqual([1, after]);
  });

  it("keeps the last minute of load for the curve", async () => {
    const t = tab();
    for (let i = 1; i <= SLOTS + 5; i++) await t.tick(sample(i, { cpu: i }));
    expect(t.line()?.match(/C/g)).toHaveLength(SLOTS - 1);
    expect(t.widget.glance?.(0)).toMatchObject({ text: `${SLOTS + 5}%`, spark: Array.from({ length: 12 }, (_, i) => SLOTS - 6 + i) });
  });

  it("shows memory use on the pill when chosen, none when the total is unknown", async () => {
    const t = tab("memory");
    expect(t.widget.glance?.(0)).toBeNull();
    await t.tick(sample(1));
    expect(t.widget.glance?.(0)).toEqual({ text: "25%", progress: 0.25 });
    await t.tick(sample(2, { memTotal: 0 }));
    expect(t.widget.glance?.(0)).toEqual({ text: "0%", progress: 0 });
    expect(t.stat("RAM").querySelector<HTMLElement>(".bar")?.style.getPropertyValue("--p")).toBe("0");
  });
});
