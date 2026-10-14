/** Hue 0–360, saturation and lightness 0–1. */
export type Hsl = readonly [h: number, s: number, l: number];

export const toHsl = (r: number, g: number, b: number): Hsl => {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
};

const GRAY = 0.08;

/** Lifts a color so it glows on black: saturated and mid-bright, unless it is essentially gray. */
export const vivid = ([h, s, l]: Hsl): string => {
  const sat = s < GRAY ? s : Math.max(s, 0.55);
  const light = Math.min(Math.max(l, 0.55), 0.68);
  return `hsl(${Math.round(h)} ${Math.round(sat * 100)}% ${Math.round(light * 100)}%)`;
};

/**
 * The most characteristic color of an RGBA pixel buffer: colorful, mid-tone pixels count most,
 * so a cover's accent wins over its background. Null for a fully transparent image.
 */
export function pickColor(rgba: ArrayLike<number>): string | null {
  let [r, g, b, weight] = [0, 0, 0, 0];
  let [ar, ag, ab, count] = [0, 0, 0, 0];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const [R, G, B, A] = [rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0, rgba[i + 3] ?? 0];
    if (A < 128) continue;
    const [, s, l] = toHsl(R, G, B);
    const w = s * s * (1 - Math.abs(l - 0.5) * 2);
    [r, g, b, weight] = [r + R * w, g + G * w, b + B * w, weight + w];
    [ar, ag, ab, count] = [ar + R, ag + G, ab + B, count + 1];
  }
  if (!count) return null;
  // Too little color to trust the weighting: fall back to the plain average.
  const [R, G, B] = weight > count * 0.02 ? [r / weight, g / weight, b / weight] : [ar / count, ag / count, ab / count];
  return vivid(toHsl(R, G, B));
}

const SAMPLE = 24;

/** The accent color of a loaded image, or null if it can't be read. */
export function imageColor(img: HTMLImageElement): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !img.naturalWidth) return null;
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
  try {
    return pickColor(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } catch {
    return null; // A cross-origin image taints the canvas.
  }
}
