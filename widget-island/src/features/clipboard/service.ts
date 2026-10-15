import { invoke } from "@tauri-apps/api/core";
import { type Clip, commands } from "./bindings";

export type { Clip };

export interface ClipboardPort {
  history(): Promise<Clip[]>;
  copy(text: string): Promise<void>;
  /** Puts an image (RGBA pixels) on the clipboard, ready for Ctrl+V. */
  copyImage(image: ImageData): Promise<void>;
  clear(): Promise<void>;
}

export const tauriClipboard: ClipboardPort = {
  history: () => commands.history(),
  copy: async (text) => void (await commands.copy(text)),
  // A raw command (no bindings): a full-screen image is tens of megabytes of pixels, sent as bytes, not JSON.
  copyImage: (image) =>
    invoke("plugin:clipboard|copy_image", new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
      headers: { "x-width": String(image.width), "x-height": String(image.height) },
    }),
  clear: async () => void (await commands.clear()),
};
