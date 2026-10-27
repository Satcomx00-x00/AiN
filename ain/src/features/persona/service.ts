import { follow, num } from "../../sdk/follow";
import { type Command, type LocalInfo, type Phase as WirePhase, commands, events } from "./bindings";

export type Control = Command;
export type { LocalInfo } from "./bindings";

/** What the conversation is doing; while live, the user's level (0–1), whether the voice speaks, and its last words. */
export type Phase = Exclude<WirePhase, { phase: "live" }> | { phase: "live"; level: number; speaking: boolean; said: string };

export const phase = (p: WirePhase): Phase => (p.phase === "live" ? { ...p, level: num(p.level) } : p);

export interface PersonaPort {
  /** Calls `onChange` with the conversation's phase now and on every change (up to 20×/s while live). */
  watch(onChange: (phase: Phase) => void): Promise<() => void>;
  /** `toggle` starts a conversation or ends it; `stop` ends it. */
  control(command: Control): Promise<void>;
  /** Calls `onChange` with PersonaPlex's install on this computer now and on every change. */
  watchLocal(onChange: (info: LocalInfo) => void): Promise<() => void>;
  /** Installs PersonaPlex on this computer, in the background. */
  install(): Promise<void>;
  /** Stops its install or its server, and deletes it with its weights. */
  remove(): Promise<void>;
  openFolder(): Promise<void>;
}

export const tauriPersona: PersonaPort = {
  watch: (onChange) => follow(events.phaseChanged, commands.state, (p) => onChange(phase(p))),
  control: async (command) => void (await commands.control(command)),
  watchLocal: (onChange) => follow(events.localChanged, commands.localStatus, onChange),
  install: async () => void (await commands.installLocal()),
  remove: async () => void (await commands.removeLocal()),
  openFolder: async () => void (await commands.openLocalDir()),
};
