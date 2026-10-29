import { invoke } from "@tauri-apps/api/core";
import { type Clip, type Picture, commands } from "./bindings";

export type { Clip, Picture };

export interface ClipboardPort {
  history(): Promise<Clip[]>;
  copy(text: string): Promise<void>;
  /** Puts a clip from the history back on the clipboard, text or image, and moves it to the front. */
  restore(id: number): Promise<void>;
  /** Puts an image (RGBA pixels) on the clipboard, ready for Ctrl+V. */
  copyImage(image: ImageData): Promise<void>;
  clear(): Promise<void>;
}

export const tauriClipboard: ClipboardPort = {
  history: () => commands.history(),
  copy: async (text) => void (await commands.copy(text)),
  restore: async (id) => void (await commands.restore(id)),
  // A raw command (no bindings): a full-screen image is tens of megabytes of pixels, sent as bytes, not JSON.
  copyImage: (image) =>
    invoke("plugin:clipboard|copy_image", new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
      headers: { "x-width": String(image.width), "x-height": String(image.height) },
    }),
  clear: async () => void (await commands.clear()),
};

/**
 * A history kept in memory, where there is no backend (the browser preview, tests): copying text or
 * restoring a clip brings it to the front, as the app does.
 */
export function memoryClipboard(initial: readonly Clip[] = []): ClipboardPort {
  let clips = [...initial];
  let next = Math.max(0, ...clips.map((c) => c.id));
  const front = (clip: Clip) => void (clips = [{ ...clip, copiedAt: Date.now() }, ...clips.filter((c) => c.id !== clip.id)]);
  return {
    history: async () => clips,
    copy: async (text) => front(clips.find((c) => !c.image && c.text === text) ?? { id: ++next, text, image: null, copiedAt: 0 }),
    restore: async (id) => {
      const clip = clips.find((c) => c.id === id);
      if (!clip) throw new Error("that clip is no longer in the history");
      front(clip);
    },
    copyImage: async () => {},
    clear: async () => void (clips = []),
  };
}
