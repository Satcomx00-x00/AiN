import { describe, expect, it, vi } from "vitest";
import type { AnyStyle } from "../sdk/style";

const { BARE, FOLDED, foldedSize, styleById, styleOptions } = await import("./styles");

const pill = { width: 200, height: 32, hasNotch: false, scale: 1 };
const style = (id: string, extra: Partial<AnyStyle> = {}): AnyStyle => ({ id, label: id, mount: () => ({ draw() {} }), ...extra });

describe("styleById", () => {
  const a = style("a");
  const b = style("b");

  it("finds the style picked", () => expect(styleById([a, b], "b")).toBe(b));
  it("falls back to the first (the default) when it is gone", () => expect(styleById([a, b], "removed-plugin")).toBe(a));
  it("falls back to a bare pill when there are none", () => expect(styleById([], "a")).toBe(BARE));

  it("has a bare pill that draws nothing and can't fail", () => {
    const root = { append: vi.fn() } as unknown as HTMLElement;
    const view = BARE.mount(root, { options: () => ({}) });
    expect(() => view.draw({ left: null, right: null, ambient: null, alert: false, wide: false, now: 0 })).not.toThrow();
    expect(root.append).not.toHaveBeenCalled();
  });
});

describe("foldedSize", () => {
  it("is the pill's own size for a style without one", () => expect(foldedSize(style("a"), pill, {})).toEqual({ width: 200, height: 32 }));

  it("takes the style's size, rounded, given the pill and the style's options", () => {
    const size = vi.fn((p: typeof pill, o: { thick: number }) => ({ width: p.width * 0.66, height: o.thick * p.scale }));
    expect(foldedSize(style("a", { size: size as never }), { ...pill, scale: 1.375 }, { thick: 5 })).toEqual({ width: 132, height: 7 });
    expect(size).toHaveBeenCalledWith({ ...pill, scale: 1.375 }, { thick: 5 });
  });

  it("keeps the size within limits, so a style can't hide the island or cover the screen", () => {
    expect(foldedSize(style("a", { size: () => ({ width: 0, height: -4 }) }), pill, {})).toEqual(FOLDED.min);
    expect(foldedSize(style("a", { size: () => ({ width: 1e6, height: 1e6 }) }), pill, {})).toEqual(FOLDED.max);
  });

  it("gives the pill's size, and says why, when the style's size fails or isn't a number", () => {
    const log = vi.fn();
    const throws = style("t", {
      size: () => {
        throw new Error("boom");
      },
    });
    expect(foldedSize(throws, pill, {}, log)).toEqual({ width: 200, height: 32 });
    expect(foldedSize(style("n", { size: () => ({ width: Number.NaN, height: 4 }) }), pill, {}, log)).toEqual({ width: 200, height: 32 });
    expect(foldedSize(style("i", { size: () => ({ width: 10, height: Infinity }) }), pill, {}, log)).toEqual({ width: 200, height: 32 });
    expect(log.mock.calls.map(([m]) => m)).toEqual([
      expect.stringContaining(`"t": size failed: Error: boom`),
      expect.stringContaining(`"n": size failed`),
      expect.stringContaining(`"i": size failed`),
    ]);
  });
});

describe("styleOptions", () => {
  const glowy = style("glowy", {
    options: {
      glow: { kind: "toggle", label: "Glow", default: true },
      thick: { kind: "number", label: "Thickness", default: 4, min: 2, max: 12, step: 1 },
    },
  });

  it("gives the defaults when nothing is stored", () => expect(styleOptions(glowy, {})).toEqual({ glow: true, thick: 4 }));

  it("reads the values stored under the style's own id, clamped to their range", () =>
    expect(styleOptions(glowy, { glowy: { glow: false, thick: 99 }, other: { glow: true } })).toEqual({ glow: false, thick: 12 }));

  it("gives the default for a stored value of the wrong kind", () =>
    expect(styleOptions(glowy, { glowy: { glow: "yes", thick: "thick" } })).toEqual({ glow: true, thick: 4 }));

  it("is empty for a style without options", () => expect(styleOptions(style("a"), { a: { x: 1 } })).toEqual({}));
});
