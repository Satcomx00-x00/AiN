import { follow, num } from "../../sdk/follow";
import { type Command, type Delivery, type ModelInfo, type Phase as WirePhase, type Status, commands, events } from "./bindings";

export type { Delivery, ModelInfo, Status as ModelStatus };
export type Control = Command;

/** What dictation is doing; while listening, the input level (0–1) and whole seconds so far. */
export type Phase = Exclude<WirePhase, { phase: "listening" }> | { phase: "listening"; level: number; seconds: number };

export const phase = (p: WirePhase): Phase => (p.phase === "listening" ? { phase: "listening", level: num(p.level), seconds: num(p.seconds) } : p);

export interface DictationPort {
  /** Calls `onChange` with the dictation phase now and on every change (the level updates ~20×/s while listening). */
  watch(onChange: (phase: Phase) => void): Promise<() => void>;
  /** Calls `onChange` with the speech model's status now and as it downloads. */
  watchModel(onChange: (status: ModelInfo) => void): Promise<() => void>;
  /** Shows the model's folder in the file manager. */
  openFolder(): Promise<void>;
  control(command: Control): Promise<void>;
  /** Starts downloading the chosen model; progress arrives through `watchModel`. */
  download(): Promise<void>;
  /** Stops a download in progress, or deletes the downloaded model. */
  remove(): Promise<void>;
}

export const tauriDictation: DictationPort = {
  watch: (onChange) => follow(events.phaseChanged, commands.state, (p) => onChange(phase(p))),
  watchModel: (onChange) => follow(events.modelChanged, commands.modelStatus, onChange),
  openFolder: async () => void (await commands.openModelDir()),
  control: async (command) => void (await commands.control(command)),
  download: async () => void (await commands.downloadModel()),
  remove: async () => void (await commands.deleteModel()),
};
