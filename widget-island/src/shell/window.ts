import { type Island as Wire, commands } from "./bindings/island";

/** The island's resting size, and whether a hardware notch dictates it. */
export interface Island {
  readonly width: number;
  readonly height: number;
  readonly hasNotch: boolean;
}

export type Size = { width: number; height: number };

/** The backend's measurement, which every layout computation divides and scales by: it must be a real size. */
export function checkIsland(i: Wire): Island {
  const { width, height } = i;
  if (width === null || height === null || !(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)))
    throw new Error(`invalid island size ${width}×${height}`);
  return { width, height, hasNotch: i.hasNotch };
}

export interface WindowPort {
  island(): Promise<Island>;
  /**
   * `canvas`: the largest the window ever needs to be. `region`: the part that takes input now.
   * The backend decides how: click-through hit-testing, or resizing where that isn't possible.
   */
  layout(canvas: Size, region: Size): Promise<void>;
}

export const tauriWindow: WindowPort = {
  island: async () => checkIsland(await commands.info()),
  layout: async (canvas, region) => void (await commands.layout(canvas, region)),
};
