import { follow } from "../../sdk/follow";
import { type Correction, type Corrector, type Delivery, type ModelInfo, type Phase, commands, events } from "./bindings";
import type { ModelFilesPort } from "../model-files";

export type { Correction, Corrector, Delivery, ModelInfo, Phase };

export interface SpellingPort {
  /** Calls `onChange` with the correction's phase now and on every change. */
  watch(onChange: (phase: Phase) => void): Promise<() => void>;
  /** Calls `onChange` with the language model's status now and as it downloads. */
  watchModel(onChange: (status: ModelInfo) => void): Promise<() => void>;
  /** Calls `onChange` with the dictionaries' status now and as they download. */
  watchDictionaries(onChange: (status: ModelInfo) => void): Promise<() => void>;
  /** Downloading, removing and showing the dictionaries, the language model's fallback. */
  readonly dictionaries: ModelFilesPort;
  /** Corrects the selected text, as the shortcut does. */
  fix(): Promise<void>;
  /** `text` corrected by the chosen engine, leaving the selection alone. */
  check(text: string): Promise<Correction>;
  /** Shows the models folder in the file manager. */
  openFolder(): Promise<void>;
  /** Starts downloading the chosen language model; progress arrives through `watchModel`. */
  download(): Promise<void>;
  /** Stops a download in progress, or deletes the downloaded language model. */
  remove(): Promise<void>;
}

export const tauriSpelling: SpellingPort = {
  watch: (onChange) => follow(events.phaseChanged, commands.state, onChange),
  watchModel: (onChange) => follow(events.modelChanged, commands.modelStatus, onChange),
  watchDictionaries: (onChange) => follow(events.dictionariesChanged, commands.dictionariesStatus, onChange),
  dictionaries: {
    download: async () => void (await commands.downloadDictionaries()),
    remove: async () => void (await commands.deleteDictionaries()),
    openFolder: async () => void (await commands.openModelDir()),
  },
  fix: async () => void (await commands.fix()),
  check: (text) => commands.check(text),
  openFolder: async () => void (await commands.openModelDir()),
  download: async () => void (await commands.downloadModel()),
  remove: async () => void (await commands.deleteModel()),
};
