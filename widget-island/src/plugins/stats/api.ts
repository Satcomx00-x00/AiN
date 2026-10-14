import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export const StatsSchema = z.object({
  cpu: z.number(),
  memUsed: z.number(),
  memTotal: z.number(),
  rxPerSec: z.number(),
  txPerSec: z.number(),
  sampledAt: z.number(),
});
export type Stats = z.infer<typeof StatsSchema>;

export interface StatsPort {
  /** Latest sample, or null until the first one is ready. */
  stats(): Promise<Stats | null>;
}

export const tauriStats: StatsPort = {
  stats: async () => StatsSchema.nullable().parse(await invoke("plugin:stats|latest")),
};
