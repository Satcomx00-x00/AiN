import { type Island as Wire, commands, events } from "./bindings/island";

/** The island's resting size, and whether a hardware notch dictates it. */
export interface Island {
  readonly width: number;
  readonly height: number;
  readonly hasNotch: boolean;
}

export type Size = { width: number; height: number };

/** A rectangle in the window, in px from its top left. */
export type Area = { x: number; y: number; width: number; height: number };

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
   * The backend decides how: click-through hit-testing, or shaping the window's input where the cursor can't be seen (Wayland).
   * `extra`: more parts that take input, anywhere in the window (bubbles beside the pill).
   */
  layout(canvas: Size, region: Size, extra?: readonly Area[]): Promise<void>;
  /**
   * Hides the pill until the cursor rests on it (top center) for `dwell` ms; once shown, it hides
   * again `grace` ms after the cursor leaves. `dwell: null` keeps it shown. The backend watches the
   * cursor, since a hidden pill lets every click through; where it can't (Wayland), nothing hides.
   */
  autoHide(dwell: number | null, grace: number): Promise<void>;
  /** Calls `onReveal` each time the auto-hide rule shows (true) or hides (false) the pill. */
  onReveal(onReveal: (shown: boolean) => void): Promise<() => void>;
}

export const tauriWindow: WindowPort = {
  island: async () => checkIsland(await commands.info()),
  layout: async (canvas, region, extra = []) => void (await commands.layout(canvas, region, [...extra])),
  autoHide: async (dwell, grace) => void (await commands.autoHide(dwell, grace)),
  onReveal: (onReveal) => events.revealed.listen((e) => onReveal(e.payload)),
};
