import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const { checkIsland, tauriWindow } = await import("./window");
const { EAR, EXPANDED, GLANCE, PILL_SIZES, SLACK, TALLEST, WIDE, earFor, frame, panelHeight, pillOf, sizeFor } = await import("./geometry");
const { pick, pickFrom, place, placedIds } = await import("./placement");
const { pickColor, toHsl, vivid } = await import("../sdk/color");
const { load } = await import("./host");
const { definePlugin } = await import("../sdk/plugin");
const { coalesce, msToNextSecond } = await import("./scheduler");
const { intent } = await import("./intent");
const { animates } = await import("../sdk/dom");

const notch = { width: 185, height: 32, hasNotch: true };

describe("geometry", () => {
  const flat = { ...notch, width: 200, hasNotch: false };
  it("collapsed leaves room for glance text beside the notch", () =>
    expect(sizeFor(false, pillOf(notch, "normal"))).toEqual({ width: 185 + 2 * GLANCE, height: 32 }));
  it("collapsed without a notch keeps its width", () => expect(sizeFor(false, pillOf(flat, "normal"))).toEqual({ width: 200, height: 32 }));
  it("expanded grows below the notch", () =>
    expect(sizeFor(true, pillOf(notch, "normal"))).toEqual({ width: EXPANDED.width, height: 32 + EXPANDED.height }));
  it("never shrinks narrower than the notch", () => expect(sizeFor(true, pillOf({ ...notch, width: 600 }, "normal")).width).toBe(600 + 2 * GLANCE));
  it("a live activity widens only the collapsed pill, more on a bigger pill", () => {
    expect(sizeFor(false, pillOf(flat, "normal"), true).width).toBe(200 + WIDE);
    expect(sizeFor(false, pillOf(flat, "large"), true, 1.375).width).toBe(260 + 132);
    expect(sizeFor(true, pillOf(notch, "normal"), true)).toEqual(sizeFor(true, pillOf(notch, "normal")));
  });
  it("sizes the pill low profile, normal or large", () => {
    expect(pillOf(flat, "low")).toEqual({ width: 160, height: 20, hasNotch: false, scale: 0.625 });
    expect(pillOf(flat, "normal")).toEqual({ width: 200, height: 32, hasNotch: false, scale: 1 });
    expect(pillOf(flat, "large")).toEqual({ width: 260, height: 44, hasNotch: false, scale: 1.375 });
  });
  it("keeps a hardware notch's size whatever the pill size", () => expect(pillOf(notch, "low")).toEqual(pillOf(notch, "large")));
  it("widens the window to fit both ears, which grow with the pill", () => {
    expect(frame({ width: 200, height: 32 })).toEqual({ width: 200 + 2 * EAR, height: 32 });
    expect(frame({ width: 260, height: 44 }, false, 1.375)).toEqual({ width: 260 + 2 * 14, height: 44 });
  });
  it("adds slack around the open pill for overshoot and shadow", () =>
    expect(frame({ width: 420, height: 188 }, true)).toEqual({ width: 420 + 2 * (EAR + SLACK), height: 188 + SLACK }));
  it("keeps the open pill's shadow inside that slack, which ends the window on Wayland", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./windows/island/island.css", import.meta.url), "utf8");
    const rule = /#island\[data-open="true"\]\s*\{[^}]*?box-shadow:([^;]+);/.exec(css)![1]!;
    // Split on the commas between shadows, not those inside color-mix(…) or rgba(…).
    let depth = 0;
    const parts = [""];
    for (const c of rule) {
      depth += c === "(" ? 1 : c === ")" ? -1 : 0;
      if (c === "," && depth === 0) parts.push("");
      else parts[parts.length - 1] += c;
    }
    const shadows = parts.map((s) => s.trim()).filter((s) => !s.startsWith("inset"));
    expect(shadows.length).toBeGreaterThan(0);
    for (const shadow of shadows) {
      const [x, y, blur, spread = 0] = shadow.match(/-?\d+(?:\.\d+)?px/g)!.map(parseFloat);
      // Below the pill, and beside it (where the ears take part of the room), with 2 px spare for the spring's overshoot.
      expect(y! + blur! + spread, shadow).toBeLessThanOrEqual(SLACK - 2);
      expect(Math.abs(x!) + blur! + spread, shadow).toBeLessThanOrEqual(SLACK);
    }
  });
  it("rounds the ears up, so the window never clips them", () => {
    expect([earFor(0.625), earFor(1), earFor(1.375)]).toEqual([7, 10, 14]);
    expect(frame({ width: 420, height: 200 }, true, 1.375)).toEqual({ width: 420 + 2 * (14 + SLACK), height: 200 + SLACK });
  });
  it("scales a custom width setting by the size's width factor", () => {
    const wide = { width: 300, height: 32, hasNotch: false };
    expect(pillOf(wide, "low").width).toBe(Math.round(300 * PILL_SIZES.low.width));
    expect(pillOf(wide, "large").width).toBe(Math.round(300 * PILL_SIZES.large.width));
  });
  it("orders the sizes from low profile to large", () => {
    expect(PILL_SIZES.low.scale).toBeLessThan(PILL_SIZES.normal.scale);
    expect(PILL_SIZES.normal.scale).toBeLessThan(PILL_SIZES.large.scale);
    expect(PILL_SIZES.normal).toEqual({ scale: 1, width: 1 });
  });
  it("opens at least as wide as the panel, whatever the folded width", () => {
    expect(sizeFor(true, { width: 35, height: 9 })).toEqual({ width: EXPANDED.width, height: 9 + EXPANDED.height });
    expect(sizeFor(true, { width: 600, height: 44 }).width).toBe(600);
  });
  it("opens to the panel a tab asks for, between the usual one and the tallest", () => {
    expect(sizeFor(true, { width: 200, height: 32 }, false, 1, 300)).toEqual({ width: EXPANDED.width, height: 332 });
    expect([panelHeight(), panelHeight(300.4), panelHeight(20), panelHeight(9999), panelHeight(Number.NaN)]).toEqual([
      EXPANDED.height,
      300,
      EXPANDED.height,
      TALLEST,
      EXPANDED.height,
    ]);
  });
});

describe("placement", () => {
  const plugin = (id: string, text: string | null, panel = true) =>
    definePlugin({
      id,
      label: id,
      description: "",
      icon: "",
      slots: ["glance", "tab"],
      setup: () => ({ glance: () => (text === null ? null : { text }), ...(panel ? { panel: () => {} } : {}) }),
    });
  const catalogue = [plugin("clock", "14:32"), plugin("timer", null), plugin("stats", "9%", false), plugin("unused", "x")];
  const layout = { glance: { left: ["clock"], right: ["timer", "stats"] }, tabs: ["clock", "timer"] };

  it("loads only the plugins the layout places", () => {
    const { mounted } = load(catalogue, layout, {});
    expect([...mounted.keys()]).toEqual(["clock", "timer", "stats"]);
    expect(placedIds(layout).has("unused")).toBe(false);
  });

  it("picks the first plugin in a spot that has something to say", () => {
    const { placement } = place(load(catalogue, layout, {}).mounted, layout);
    expect(pick(placement.left, 0)).toEqual({ text: "14:32" });
    expect(pick(placement.right, 0)).toEqual({ text: "9%" });
  });

  it("keeps tab order from the layout", () => {
    const { placement } = place(load(catalogue, layout, {}).mounted, layout);
    expect(placement.tabs.map((m) => m.plugin.id)).toEqual(["clock", "timer"]);
  });

  it("reports unknown ids and plugins placed where they have nothing to show", () => {
    const bad = { glance: { left: ["nope"], right: [] }, tabs: ["stats"] };
    const { placement, problems } = place(load(catalogue, bad, {}).mounted, bad);
    expect(placement.tabs).toEqual([]);
    expect(problems).toEqual(['glance.left: unknown plugin "nope"', 'tabs: "stats" has nothing to show there']);
  });

  it("reports duplicate plugin ids", () =>
    expect(load([...catalogue, plugin("clock", null)], layout, {}).problems).toEqual(['duplicate plugin id "clock"']));

  it("an empty spot shows nothing", () => expect(pick([], 0)).toBeNull());

  it("says which plugin is speaking", () => {
    const { placement } = place(load(catalogue, layout, {}).mounted, layout);
    expect(pickFrom(placement.right, 0)?.from.plugin.id).toBe("stats");
  });
});

describe("scheduler", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("never overlaps runs and collapses extra calls into one follow-up", async () => {
    let active = 0;
    let peak = 0;
    let runs = 0;
    const gates: (() => void)[] = [];
    const run = coalesce(async () => {
      runs++;
      peak = Math.max(peak, ++active);
      await new Promise<void>((r) => gates.push(r));
      active--;
    });
    void run();
    void run();
    void run();
    expect(runs).toBe(1);
    gates.shift()?.();
    await flush();
    expect(runs).toBe(2);
    gates.shift()?.();
    await flush();
    expect([runs, peak]).toEqual([2, 1]);
  });

  it("keeps working after a failed run", async () => {
    let calls = 0;
    const run = coalesce(async () => {
      if (++calls === 1) throw new Error("boom");
    });
    await expect(run()).rejects.toThrow("boom");
    await run();
    expect(calls).toBe(2);
  });

  it("aims just past the next wall-clock second", () => {
    expect(msToNextSecond(10_000)).toBe(1008);
    expect(msToNextSecond(10_990)).toBe(18);
  });
});

describe("intent", () => {
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    vi.useFakeTimers();
    let open = false;
    const apply = vi.fn((o: boolean) => (open = o));
    return { apply, hover: intent(apply, () => open, () => ({ open: 140, close: 260 })) };
  };

  it("opens only after the hover delay", () => {
    const { apply, hover } = setup();
    hover.enter();
    vi.advanceTimersByTime(139);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenLastCalledWith(true);
  });

  it("passing by without dwelling never opens", () => {
    const { apply, hover } = setup();
    hover.enter();
    vi.advanceTimersByTime(50);
    hover.leave();
    vi.advanceTimersByTime(1000);
    expect(apply).not.toHaveBeenCalledWith(true);
  });

  it("returning within the grace time keeps it open", () => {
    const { apply, hover } = setup();
    hover.set(true);
    hover.leave();
    vi.advanceTimersByTime(200);
    hover.enter();
    vi.advanceTimersByTime(1000);
    expect(apply).not.toHaveBeenCalledWith(false);
  });
});

describe("tauri window", () => {
  it("calls the island plugin", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(notch);
    expect(await tauriWindow.island()).toEqual(notch);
    expect(invoke).toHaveBeenLastCalledWith("plugin:island|info");
  });

  it("rejects malformed responses", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ width: "wide" });
    await expect(tauriWindow.island()).rejects.toThrow();
  });

  it.each([0, -1, null, Number.NaN, Number.POSITIVE_INFINITY])("rejects a width of %s: layout divides by it", (width) =>
    expect(() => checkIsland({ ...notch, width })).toThrow(),
  );

  it("sizes the island with the layout plugin, sending both rectangles", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await tauriWindow.layout({ width: 300, height: 40 }, { width: 200, height: 32 });
    expect(invoke).toHaveBeenLastCalledWith("plugin:island|layout", { canvas: { width: 300, height: 40 }, region: { width: 200, height: 32 } });
  });
});

describe("animates", () => {
  it("is true when any transition has a duration", () => expect(animates("0s, 0.45s")).toBe(true));
  it("is false under reduced motion", () => expect(animates("0s")).toBe(false));
});

describe("color", () => {
  const image = (...pixels: [number, number, number, number][]) => pixels.flat();

  it("converts to HSL", () => {
    expect(toHsl(255, 0, 0)).toEqual([0, 1, 0.5]);
    expect(toHsl(128, 128, 128)[1]).toBe(0);
  });

  it("lifts colors so they glow on black, but leaves grays gray", () => {
    expect(vivid([210, 0.3, 0.2])).toBe("hsl(210 55% 55%)");
    expect(vivid([0, 0, 0.9])).toBe("hsl(0 0% 68%)");
  });

  it("lets a colorful accent beat a dull background", () =>
    expect(pickColor(image([20, 20, 20, 255], [20, 20, 20, 255], [20, 20, 20, 255], [0, 200, 80, 255]))).toMatch(/^hsl\((14[0-9]|15[0-9]) /));

  it("falls back to the average for grayscale art", () =>
    expect(pickColor(image([100, 100, 100, 255], [140, 140, 140, 255]))).toBe("hsl(0 0% 55%)"));

  it("ignores transparent pixels", () => expect(pickColor(image([255, 0, 0, 0]))).toBeNull());
});
