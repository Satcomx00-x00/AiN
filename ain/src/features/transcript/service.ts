import { follow, num } from "../../sdk/follow";
import { type Command, type Line, type Phase as WirePhase, commands, events } from "./bindings";

export type { Line };
export type Control = Command;

/** What the transcript is doing; while listening, the sound's level (0–1) and whole seconds so far. */
export type Phase = Exclude<WirePhase, { phase: "listening" }> | { phase: "listening"; level: number; seconds: number };

export const phase = (p: WirePhase): Phase => (p.phase === "listening" ? { phase: "listening", level: num(p.level), seconds: num(p.seconds) } : p);

export interface TranscriptPort {
  /** Calls `onChange` with the phase now and on every change (the level updates ~20×/s while listening). */
  watch(onChange: (phase: Phase) => void): Promise<() => void>;
  /** Calls `onChange` with every line heard so far, now and as lines are added or cleared. */
  watchLines(onChange: (lines: readonly Line[]) => void): Promise<() => void>;
  /** Starts or stops listening to the computer's sound, or forgets what was heard. */
  control(command: Control): Promise<void>;
}

export const tauriTranscript: TranscriptPort = {
  watch: (onChange) => follow(events.phaseChanged, commands.state, (p) => onChange(phase(p))),
  watchLines: (onChange) => follow(events.linesChanged, commands.lines, onChange),
  control: async (command) => void (await commands.control(command)),
};
