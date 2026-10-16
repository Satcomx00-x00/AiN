import { resolve } from "../sdk/options";
import type { AnyStyle, Pill } from "../sdk/style";
import type { Size } from "./window";

/** Used when no style is given at all: draws nothing, so the island still runs. */
export const BARE: AnyStyle = { id: "bare", label: "Bare", mount: () => ({ draw() {} }) };

/** The style picked, or the first one (the default) when it is gone, e.g. its plugin was removed. */
export const styleById = (styles: readonly AnyStyle[], id: string): AnyStyle => styles.find((s) => s.id === id) ?? styles[0] ?? BARE;

/** Limits on a style's folded size, so one can't hide the island or cover the screen. */
export const FOLDED = { min: { width: 8, height: 2 }, max: { width: 960, height: 120 } } as const;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

/** The style's folded size for `pill`, within limits; the pill's own when the style fails or has none. */
export function foldedSize(style: AnyStyle, pill: Pill, options: unknown, log: (message: string) => void = console.error): Size {
  if (!style.size) return { width: pill.width, height: pill.height };
  try {
    const { width, height } = style.size(pill, options as never);
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`not a size: ${width}×${height}`);
    return { width: clamp(width, FOLDED.min.width, FOLDED.max.width), height: clamp(height, FOLDED.min.height, FOLDED.max.height) };
  } catch (e) {
    log(`[island] pill style "${style.id}": size failed: ${String(e)}`);
    return { width: pill.width, height: pill.height };
  }
}

/** A style's option values, from what is stored for it. */
export const styleOptions = (style: AnyStyle, stored: Readonly<Record<string, Readonly<Record<string, unknown>>>>): unknown =>
  resolve(style.options ?? {}, stored[style.id]);
