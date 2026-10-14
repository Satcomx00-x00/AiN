import { invoke } from "@tauri-apps/api/core";

/** Width and height as little-endian u32s, ahead of the RGBA pixels. */
const HEADER = 8;

export interface ScreenPort {
  /** The capture taken when the shortcut fired, or null if there is none. */
  latest(): Promise<ImageData | null>;
  /** Saves a PNG to Pictures/Island under `name`; resolves with the file's path. */
  save(png: Uint8Array, name: string): Promise<string>;
}

export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
}

/** Decodes `[width][height][RGBA…]` without copying; null for an empty or inconsistent buffer. */
export function decode(buffer: ArrayBuffer): Pixels | null {
  if (buffer.byteLength < HEADER) return null;
  const view = new DataView(buffer);
  const [width, height] = [view.getUint32(0, true), view.getUint32(4, true)];
  if (!width || !height || buffer.byteLength - HEADER !== width * height * 4) return null;
  return { width, height, rgba: new Uint8ClampedArray(buffer, HEADER) };
}

export const tauriScreen: ScreenPort = {
  latest: async () => {
    const pixels = decode(await invoke<ArrayBuffer>("plugin:screen|latest"));
    return pixels && new ImageData(pixels.rgba, pixels.width, pixels.height);
  },
  save: (png, name) => invoke<string>("plugin:screen|save_png", png, { headers: { "x-name": name } }),
};
