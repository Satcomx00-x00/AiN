import { num } from "../../sdk/follow";
import { type Stats as Wire, commands } from "./bindings";

export type Stats = { readonly [K in keyof Wire]: number };

export interface StatsPort {
  /** Latest sample, or null until the first one is ready. */
  stats(): Promise<Stats | null>;
}

export const fromWire = (s: Wire): Stats => ({ ...s, cpu: num(s.cpu), rxPerSec: num(s.rxPerSec), txPerSec: num(s.txPerSec) });

export const tauriStats: StatsPort = {
  stats: async () => {
    const s = await commands.latest();
    return s && fromWire(s);
  },
};
