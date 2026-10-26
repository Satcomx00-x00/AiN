import { follow, num } from "../../sdk/follow";
import { type Command, type Phase as WirePhase, commands, events } from "./bindings";

export type Control = Command;

/** What the conversation is doing; while live, the user's level (0–1), whether the voice speaks, and its last words. */
export type Phase = Exclude<WirePhase, { phase: "live" }> | { phase: "live"; level: number; speaking: boolean; said: string };

export const phase = (p: WirePhase): Phase => (p.phase === "live" ? { ...p, level: num(p.level) } : p);

export interface PersonaPort {
  /** Calls `onChange` with the conversation's phase now and on every change (up to 20×/s while live). */
  watch(onChange: (phase: Phase) => void): Promise<() => void>;
  /** `toggle` starts a conversation or ends it; `stop` ends it. */
  control(command: Control): Promise<void>;
}

export const tauriPersona: PersonaPort = {
  watch: (onChange) => follow(events.phaseChanged, commands.state, (p) => onChange(phase(p))),
  control: async (command) => void (await commands.control(command)),
};
