import { describe, expect, it } from "vitest";
import { curve, curveArea } from "./chart";

describe("curveArea", () => {
  it("has no area without values", () => expect(curveArea([], 20, 10)).toBe(""));

  it("is a single point closed down to the baseline for one value", () => expect(curveArea([50], 20, 10, 100, 3)).toBe("M20,5 L20,10 L20,10 Z"));
});

describe("curve", () => {
  it("draws a straight line between two points, the ends standing in for the missing neighbours", () =>
    expect(curve([0, 100], 20, 10, 100, 3)).toBe("M10,10 C11.7,8.3 18.3,1.7 20,0"));
});
