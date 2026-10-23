/** The voice models on offer; the ids and order match `MODELS` in src-tauri/src/features/tts/model.rs. */
export interface VoiceModel {
  readonly id: string;
  readonly name: string;
  /** What it speaks, and what it's good at. */
  readonly about: string;
  /** Download size in MB, roughly. */
  readonly mb: number;
  /** Its speakers, in the model's order; one-voice models list none. */
  readonly voices: readonly string[];
}

const KOKORO_VOICES = [
  "Default (US, female)",
  "Bella (US, female)",
  "Nicole (US, female)",
  "Sarah (US, female)",
  "Sky (US, female)",
  "Adam (US, male)",
  "Michael (US, male)",
  "Emma (UK, female)",
  "Isabella (UK, female)",
  "George (UK, male)",
  "Lewis (UK, male)",
];

const KITTEN_VOICES = [2, 3, 4, 5].flatMap((n) => [`Voice ${n} (male)`, `Voice ${n} (female)`]);

export const MODELS: readonly VoiceModel[] = [
  { id: "kokoro-en", name: "Kokoro", about: "English, 11 voices, the most natural", mb: 305, voices: KOKORO_VOICES },
  { id: "kitten-nano", name: "Kitten nano", about: "English, 8 voices, tiny and quick", mb: 25, voices: KITTEN_VOICES },
  { id: "piper-en-lessac", name: "Piper · Lessac", about: "English (US), light and clear", mb: 64, voices: [] },
  { id: "piper-fr-siwis", name: "Piper · Siwis", about: "French, light and clear", mb: 64, voices: [] },
  { id: "kokoro-fr", name: "Kokoro · Siwis", about: "French, the most natural; largest download", mb: 350, voices: [] },
  { id: "piper-fr-upmc", name: "Piper · UPMC", about: "French, 2 voices", mb: 80, voices: ["Jessica (female)", "Pierre (male)"] },
  { id: "piper-fr-tom", name: "Piper · Tom", about: "French, male voice", mb: 67, voices: [] },
  { id: "piper-de-thorsten", name: "Piper · Thorsten", about: "German, light and clear", mb: 64, voices: [] },
  { id: "piper-es-davefx", name: "Piper · Davefx", about: "Spanish (Spain), light and clear", mb: 64, voices: [] },
];

export const DEFAULT_MODEL = MODELS[0]!.id;

/** The model with this id, or the default one. */
export const modelById = (id: string): VoiceModel => MODELS.find((m) => m.id === id) ?? MODELS[0]!;
