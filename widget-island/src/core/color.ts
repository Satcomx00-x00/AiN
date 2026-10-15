/** "#rrggbb", as the color settings store it. */
export const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/** Whether dark text reads better than light text on this "#rrggbb" color (WCAG relative luminance). */
export const isLight = (hex: string): boolean => {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5) > 0.18;
};

/** Hue 0–360, saturation and value 0–1, as a color picker shows them. */
export type Hsv = readonly [h: number, s: number, v: number];

export const hexToHsv = (hex: string): Hsv => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max === 0 ? 0 : d / max, max];
};

export const hsvToHex = ([h, s, v]: Hsv): string => {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
};

/** "#rrggbb" from what someone typed ("0A84FF", "#0a84ff", "#08f"), or null. */
export const parseHex = (typed: string): string | null => {
  const raw = typed.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
  if (/^[0-9a-f]{3}$/.test(raw)) return `#${[...raw].map((c) => c + c).join("")}`;
  return null;
};

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
