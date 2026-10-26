// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { imageColor, pickColor, toHsl } from "./color";

afterEach(() => vi.restoreAllMocks());

describe("toHsl", () => {
  it("finds the hue of whichever channel is strongest", () => {
    expect(toHsl(0, 255, 0)).toEqual([120, 1, 0.5]);
    expect(toHsl(0, 0, 255)).toEqual([240, 1, 0.5]);
  });
});

describe("pickColor", () => {
  it("reads gaps in the buffer as transparent", () => expect(pickColor(new Array<number>(8))).toBeNull());
});

describe("imageColor", () => {
  /** A loaded image `width` pixels wide. */
  const image = (width: number) => {
    const img = document.createElement("img");
    Object.defineProperty(img, "naturalWidth", { value: width });
    return img;
  };

  /** A 2D context whose pixels are `pixel` repeated, or whose read throws `fail`. */
  function canvas(pixel: number[], fail?: Error) {
    const ctx = {
      drawImage: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
        if (fail) throw fail;
        return { data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => pixel[i % 4] ?? 0) };
      }),
    };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    return { ctx, getContext };
  }

  it("samples the image small and picks its color", () => {
    const { ctx, getContext } = canvas([0, 200, 80, 255]);
    const img = image(640);
    expect(imageColor(img)).toBe(pickColor([0, 200, 80, 255]));
    expect(getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true });
    expect(ctx.drawImage).toHaveBeenCalledWith(img, 0, 0, 24, 24);
    expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 24, 24);
  });

  it("gives null for an image that hasn't loaded", () => {
    const { ctx } = canvas([0, 200, 80, 255]);
    expect(imageColor(image(0))).toBeNull();
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it("gives null without a 2D canvas", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(imageColor(image(640))).toBeNull();
  });

  it("gives null for a cross-origin image, whose pixels can't be read", () => {
    canvas([0, 200, 80, 255], new DOMException("tainted", "SecurityError"));
    expect(imageColor(image(640))).toBeNull();
  });
});
