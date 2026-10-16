/** The speech models on offer; the ids and order match `MODELS` in src-tauri/src/features/dictation/model.rs. */
export interface SpeechModel {
  readonly id: string;
  readonly name: string;
  /** What it understands, and what it's good at. */
  readonly about: string;
  /** Download size in MB. */
  readonly mb: number;
}

export const MODELS: readonly SpeechModel[] = [
  { id: "parakeet-v3", name: "Parakeet TDT v3", about: "25 European languages, fast and accurate", mb: 670 },
  { id: "parakeet-v2", name: "Parakeet TDT v2", about: "English only, the most accurate in English", mb: 661 },
  { id: "whisper-turbo", name: "Whisper large-v3 turbo", about: "99 languages, the most accurate, slower", mb: 1037 },
  { id: "whisper-small", name: "Whisper small", about: "99 languages, a good balance", mb: 375 },
  { id: "whisper-base", name: "Whisper base", about: "99 languages, light and quick, less accurate", mb: 161 },
  { id: "sense-voice", name: "SenseVoice", about: "Chinese, Cantonese, English, Japanese, Korean", mb: 240 },
  { id: "moonshine-base", name: "Moonshine base", about: "English only, very fast", mb: 287 },
];

export const DEFAULT_MODEL = MODELS[0]!.id;

/** The model with this id, or the default one. */
export const modelById = (id: string): SpeechModel => MODELS.find((m) => m.id === id) ?? MODELS[0]!;
