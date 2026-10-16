import { follow, num } from "../../sdk/follow";
import { type Output as WireOutput, type Source as WireSource, commands, events } from "./bindings";

/** The default output: level 0–1, mute, and the device's name. */
export type Output = Omit<WireOutput, "level"> & { readonly level: number };
/** A device or an app with its own volume; `id` is "device:<id>" or "app:<program>". */
export type Source = Omit<WireSource, "level"> & { readonly level: number };

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

export const output = (o: WireOutput | null): Output | null => o && { ...o, level: num(o.level) };
export const sources = (list: WireSource[]): Source[] => list.map((s) => ({ ...s, level: num(s.level) }));

export const tauriVolume: VolumePort = {
  watch: (onChange) => follow(events.outputChanged, commands.state, (o) => onChange(output(o))),
  watchSources: (onChange) => follow(events.sourcesChanged, commands.sources, (list) => onChange(sources(list))),
  peak: async () => num(await commands.peak()),
  setLevel: async (level, source) => void (await commands.setLevel(source ?? null, level)),
  setMuted: async (muted, source) => void (await commands.setMuted(source ?? null, muted)),
};
