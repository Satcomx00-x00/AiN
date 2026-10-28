/** The language models on offer; the ids and order match `MODELS` in src-tauri/src/features/spelling/llm.rs. */
export interface LanguageModel {
  readonly id: string;
  readonly name: string;
  /** What it's good at. */
  readonly about: string;
  /** Download size in MB, roughly. */
  readonly mb: number;
}

export const MODELS: readonly LanguageModel[] = [
  { id: "qwen2.5-1.5b", name: "Qwen2.5 1.5B", about: "Spelling and grammar, French and English; the most accurate", mb: 1120 },
  { id: "qwen2.5-0.5b", name: "Qwen2.5 0.5B", about: "Lighter and quicker, less accurate", mb: 490 },
];

export const DEFAULT_MODEL = MODELS[0]!.id;

/** The model with this id, or the default one. */
export const modelById = (id: string): LanguageModel => MODELS.find((m) => m.id === id) ?? MODELS[0]!;
