import { follow } from "../../sdk/follow";
import { type Command, type ModelInfo, type Phase, type Status, commands, events } from "./bindings";

export type { ModelInfo, Phase, Status as ModelStatus };
export type Control = Command;

export interface TtsPort {
  /** Calls `onChange` with the reading's phase now and on every change. */
  watch(onChange: (phase: Phase) => void): Promise<() => void>;
  /** Calls `onChange` with the voice model's status now and as it downloads. */
  watchModel(onChange: (status: ModelInfo) => void): Promise<() => void>;
  /** Shows the model's folder in the file manager. */
  openFolder(): Promise<void>;
  /** `toggle` reads the selected text, or stops reading; `stop` stops. */
  control(command: Control): Promise<void>;
  /** Reads `text` out loud: to read something again, or to try a voice. */
  speak(text: string): Promise<void>;
  /** Starts downloading the chosen model; progress arrives through `watchModel`. */
  download(): Promise<void>;
  /** Stops a download in progress, or deletes the downloaded model. */
  remove(): Promise<void>;
}

export const tauriTts: TtsPort = {
  watch: (onChange) => follow(events.phaseChanged, commands.state, onChange),
  watchModel: (onChange) => follow(events.modelChanged, commands.modelStatus, onChange),
  openFolder: async () => void (await commands.openModelDir()),
  control: async (command) => void (await commands.control(command)),
  speak: async (text) => void (await commands.speak(text)),
  download: async () => void (await commands.downloadModel()),
  remove: async () => void (await commands.deleteModel()),
};
