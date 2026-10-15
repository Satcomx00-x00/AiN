import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { follow } from "../../core/live";

export const PhaseSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle") }),
  z.object({ phase: z.literal("needsModel") }),
  z.object({ phase: z.literal("listening"), level: z.number(), seconds: z.number() }),
  z.object({ phase: z.literal("transcribing") }),
  z.object({ phase: z.literal("done"), text: z.string() }),
  z.object({ phase: z.literal("error"), message: z.string() }),
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const ModelSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing"), size: z.number() }),
  z.object({ state: z.literal("downloading"), received: z.number(), total: z.number() }),
  z.object({ state: z.literal("ready") }),
  z.object({ state: z.literal("error"), message: z.string() }),
]);
export type ModelStatus = z.infer<typeof ModelSchema>;

export type Control = "start" | "stop" | "toggle" | "cancel";

export interface DictationPort {
  /** Calls `onChange` with the dictation phase now and on every change (the level updates ~20×/s while listening). */
  watch(onChange: (phase: Phase) => void): Promise<() => void>;
  /** Calls `onChange` with the speech model's status now and as it downloads. */
  watchModel(onChange: (status: ModelStatus) => void): Promise<() => void>;
  control(command: Control): Promise<void>;
  /** Starts downloading the model (670 MB); progress arrives through `watchModel`. */
  download(): Promise<void>;
  /** Stops a download in progress, or deletes the downloaded model. */
  remove(): Promise<void>;
}

export const tauriDictation: DictationPort = {
  watch: (onChange) => follow("dictation:state", "plugin:dictation|state", PhaseSchema, onChange),
  watchModel: (onChange) => follow("dictation:model", "plugin:dictation|model_status", ModelSchema, onChange),
  control: (command) => invoke("plugin:dictation|control", { command }),
  download: () => invoke("plugin:dictation|download_model"),
  remove: () => invoke("plugin:dictation|delete_model"),
};
