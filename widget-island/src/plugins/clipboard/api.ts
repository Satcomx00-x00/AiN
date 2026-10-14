import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export const ClipSchema = z.object({ text: z.string(), copiedAt: z.number() });
export type Clip = z.infer<typeof ClipSchema>;

export interface ClipboardPort {
  history(): Promise<Clip[]>;
  copy(text: string): Promise<void>;
  /** Puts an image (RGBA pixels) on the clipboard, ready for Ctrl+V. */
  copyImage(image: ImageData): Promise<void>;
  clear(): Promise<void>;
}

export const tauriClipboard: ClipboardPort = {
  history: async () => z.array(ClipSchema).parse(await invoke("plugin:clipboard|history")),
  copy: (text) => invoke("plugin:clipboard|copy", { text }),
  // Raw bytes, not JSON: a full-screen image is tens of megabytes of pixels.
  copyImage: (image) =>
    invoke("plugin:clipboard|copy_image", new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
      headers: { "x-width": String(image.width), "x-height": String(image.height) },
    }),
  clear: () => invoke("plugin:clipboard|clear"),
};
