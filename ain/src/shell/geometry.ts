import type { Pill, PillSize } from "../sdk/style";
import type { Island, Size } from "./window";

export const EXPANDED = { width: 420, height: 156 } as const;

/** Room on each side of a hardware notch for the collapsed glance text. */
export const GLANCE = 64;

/** Width of the inverted top corners drawn outside the pill, at the Normal size. */
export const EAR = 10;

/** Extra window room while open, so the spring overshoot and shadow aren't clipped. */
export const SLACK = 16;

/** Extra collapsed width while a glance asks to be wide (a live activity), at the Normal size. */
export const WIDE = 96;

/** How each pill size scales the pill: its height and content (`scale`), and its width. */
export const PILL_SIZES: Readonly<Record<PillSize, { readonly scale: number; readonly width: number }>> = {
  low: { scale: 0.625, width: 0.8 },
  normal: { scale: 1, width: 1 },
  large: { scale: 1.375, width: 1.3 },
};

/** The folded pill at the chosen size. A hardware notch keeps its own size, plus room for glances beside it. */
export function pillOf(i: Island, size: PillSize): Pill {
  if (i.hasNotch) return { width: i.width + 2 * GLANCE, height: i.height, hasNotch: true, scale: 1 };
  const { scale, width } = PILL_SIZES[size];
  return { width: Math.round(i.width * width), height: Math.round(i.height * scale), hasNotch: false, scale };
}

/** Size of the pill itself, from the style's folded size; open, it is never narrower than folded. */
export const sizeFor = (open: boolean, folded: Size, wide = false, scale = 1): Size => {
  if (open) return { width: Math.max(EXPANDED.width, folded.width), height: folded.height + EXPANDED.height };
  return { width: folded.width + (wide ? Math.round(WIDE * scale) : 0), height: folded.height };
};

/** Width of each ear at `scale`, rounded up so the window never clips it. */
export const earFor = (scale = 1): number => Math.ceil(EAR * scale);

/** Size of the window that holds the pill. */
export const frame = ({ width, height }: Size, open = false, scale = 1): Size => {
  const pad = open ? SLACK : 0;
  return { width: width + 2 * (earFor(scale) + pad), height: height + pad };
};
