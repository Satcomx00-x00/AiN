import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { follow } from "../../core/live";

export const OutputSchema = z.object({ level: z.number(), muted: z.boolean(), device: z.string() });
export type Output = z.infer<typeof OutputSchema>;

export const SourceSchema = z.object({
  /** "device:<endpoint id>" or "app:<exe>". */
  id: z.string(),
  kind: z.enum(["device", "app"]),
  name: z.string(),
  level: z.number(),
  muted: z.boolean(),
  /** The default output device. */
  default: z.boolean(),
  /** For apps: currently making sound. */
  active: z.boolean(),
});
export type Source = z.infer<typeof SourceSchema>;

export interface VolumePort {
  /** Calls `onChange` with the default output (null when unavailable) and on every change. */
  watch(onChange: (output: Output | null) => void): Promise<() => void>;
  /** Calls `onChange` with every mixable source — devices and apps — and on every change. */
  watchSources(onChange: (sources: Source[]) => void): Promise<() => void>;
  /** Current loudness of the default output, 0–1. */
  peak(): Promise<number>;
  /** `source` is a source id; omitted, the default output. */
  setLevel(level: number, source?: string): Promise<void>;
  setMuted(muted: boolean, source?: string): Promise<void>;
}

export const tauriVolume: VolumePort = {
  watch: (onChange) => follow("volume:state", "plugin:volume|state", OutputSchema.nullable(), onChange),
  watchSources: (onChange) => follow("volume:sources", "plugin:volume|sources", z.array(SourceSchema), onChange),
  peak: async () => z.number().parse(await invoke("plugin:volume|peak")),
  setLevel: (level, source) => invoke("plugin:volume|set_level", { level, source: source ?? null }),
  setMuted: (muted, source) => invoke("plugin:volume|set_muted", { muted, source: source ?? null }),
};
