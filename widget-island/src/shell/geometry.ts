import type { Island, Size } from "./window";

export const EXPANDED = { width: 420, height: 156 } as const;

/** Room on each side of a hardware notch for the collapsed glance text. */
export const GLANCE = 64;

/** Width of the inverted top corners drawn outside the pill. */
export const EAR = 10;

/** Extra window room while open, so the spring overshoot and shadow aren't clipped. */
export const SLACK = 16;

/** Extra collapsed width while a glance asks to be wide (a live activity). */
export const WIDE = 96;

/** Size of the pill itself. */
export const sizeFor = (open: boolean, i: Island, wide = false): Size => {
  const width = i.hasNotch ? i.width + 2 * GLANCE : i.width;
  if (open) return { width: Math.max(EXPANDED.width, width), height: i.height + EXPANDED.height };
  return { width: width + (wide ? WIDE : 0), height: i.height };
};

/** Size of the window that holds the pill. */
export const frame = ({ width, height }: Size, open = false): Size => {
  const pad = open ? SLACK : 0;
  return { width: width + 2 * (EAR + pad), height: height + pad };
};
