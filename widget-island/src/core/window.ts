import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export const IslandSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  hasNotch: z.boolean(),
});
export type Island = z.infer<typeof IslandSchema>;

export type Size = { width: number; height: number };

export interface WindowPort {
  island(): Promise<Island>;
  /**
   * `canvas`: the largest the window ever needs to be. `region`: the part that takes input now.
   * The backend decides how: click-through hit-testing, or resizing where that isn't possible.
   */
  layout(canvas: Size, region: Size): Promise<void>;
}

export const tauriWindow: WindowPort = {
  island: async () => IslandSchema.parse(await invoke("plugin:island|info")),
  layout: (canvas, region) => invoke("plugin:island|layout", { canvas, region }),
};
