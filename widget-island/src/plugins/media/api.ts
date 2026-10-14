import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { follow } from "../../core/live";

export const TrackSchema = z.object({
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  app: z.string(),
  playing: z.boolean(),
  positionMs: z.number(),
  durationMs: z.number(),
  measuredAt: z.number(),
  artworkKey: z.string(),
});
export type Track = z.infer<typeof TrackSchema>;

export type Control = "toggle" | "next" | "previous";

export interface MediaPort {
  /** Calls `onChange` with the current track (null when nothing plays) and on every change. */
  watch(onChange: (track: Track | null) => void): Promise<() => void>;
  /** Current artwork as a `data:` URL. */
  artwork(): Promise<string | null>;
  control(action: Control): Promise<void>;
}

export const tauriMedia: MediaPort = {
  watch: (onChange) => follow("media:state", "plugin:media|state", TrackSchema.nullable(), onChange),
  artwork: async () => z.string().nullable().parse(await invoke("plugin:media|artwork")),
  control: (action) => invoke("plugin:media|control", { action }),
};
