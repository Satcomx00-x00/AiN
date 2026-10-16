// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Folded, PillSize } from "../../sdk/style";

const { styles } = await import(".");
const { pillOf } = await import("../../shell/geometry");

afterEach(() => vi.restoreAllMocks());

const quiet: Folded = { left: null, right: null, ambient: null, alert: false, wide: false, now: 0 };
const byId = (id: string) => styles.find((s) => s.id === id)!;
const island = { width: 200, height: 32, hasNotch: false };

describe("the built-in pill styles", () => {
  it("have distinct, valid ids, labels and descriptions, the Pill first (the default)", () => {
    expect(styles.map((s) => s.id)).toEqual(["pill", "hidden"]);
    for (const s of styles) {
      expect(s.id).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(s.label.trim()).not.toBe("");
      expect(s.description?.trim()).not.toBe("");
    }
  });

  it("come in every pill size, at the pill's own size", () => {
    const sizes: [PillSize, number, number][] = [["low", 160, 20], ["normal", 200, 32], ["large", 260, 44]];
    for (const s of styles)
      for (const [size, width, height] of sizes) {
        const pill = pillOf(island, size);
        expect(s.size?.(pill, {}) ?? { width: pill.width, height: pill.height }).toEqual({ width, height });
      }
  });
});

describe("the Pill", () => {
  it("shows one glance at each end, from the plugins speaking there", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const root = document.createElement("div");
    const view = byId("pill").mount(root, { options: () => ({}) });
    view.draw({ ...quiet, left: { text: "00:41" }, right: { text: "62%", progress: 0.62 }, leftFrom: "clock", rightFrom: "stats" });
    expect(root.children).toHaveLength(2);
    expect([...root.querySelectorAll(".g-text")].map((t) => t.textContent)).toEqual(["00:41", "62%"]);
  });

  it("is the same look as Hidden, which only stays out of sight", () => {
    expect([byId("pill").hidden, byId("hidden").hidden]).toEqual([undefined, true]);
    expect(byId("hidden").mount).toBe(byId("pill").mount);
  });
});
