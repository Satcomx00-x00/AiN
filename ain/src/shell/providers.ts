import { z } from "zod";
import { commands } from "./bindings/providers";
import type { Auth, Provider } from "./bindings/providers";

export type { Auth };

/** What an AI feature asks of a provider's model. */
export type Capability = "stt" | "tts";

/** A provider the app knows: its address, where its key usually is, and models worth suggesting. */
export interface Preset {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly auth: Auth;
  readonly models: Readonly<Record<Capability, readonly string[]>>;
  /** Text to speech's voices. */
  readonly voices: readonly string[];
}

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];

/** Known providers, then a custom OpenAI-compatible server (a gateway, vLLM, LocalAI, Speaches…). */
export const PRESETS = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    auth: { kind: "env", name: "OPENAI_API_KEY" },
    models: { stt: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"], tts: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] },
    voices: OPENAI_VOICES,
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: { kind: "env", name: "GROQ_API_KEY" },
    models: { stt: ["whisper-large-v3-turbo", "whisper-large-v3"], tts: [] },
    voices: [],
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    auth: { kind: "env", name: "MISTRAL_API_KEY" },
    models: { stt: ["voxtral-mini-latest"], tts: [] },
    voices: [],
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    baseUrl: "http://localhost:8000/v1",
    auth: { kind: "none" },
    models: { stt: [], tts: [] },
    voices: [],
  },
] as const satisfies readonly Preset[];

export type PresetId = (typeof PRESETS)[number]["id"];
const PRESET_IDS = PRESETS.map((p) => p.id) as [PresetId, ...PresetId[]];

export const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1]!;

/** A provider in the settings: what the backend reads (`Provider`), and the preset it started from. */
export interface AiProvider extends Provider {
  readonly preset: PresetId;
  readonly auth: Auth;
}

const ID = /^[a-z][a-z0-9-]{1,31}$/;
/** An environment variable's name, as every shell accepts it. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const authSchema: z.ZodType<Auth> = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("env"), name: z.string().max(128) }),
    z.object({ kind: z.literal("file"), path: z.string().max(1024) }),
  ])
  .catch({ kind: "none" });

const providerSchema = z.object({
  id: z.string().regex(ID),
  name: z.string().trim().min(1).max(64),
  preset: z.enum(PRESET_IDS).catch("custom"),
  baseUrl: z.string().trim().max(512),
  auth: authSchema,
});

/** The providers stored, skipping any that doesn't read and any id seen before. */
export function parseProviders(raw: unknown): AiProvider[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((item) => {
    const parsed = providerSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.id)) return [];
    seen.add(parsed.data.id);
    return [parsed.data];
  });
}

/** What's wrong with a provider, for Settings to say; null when it can be used. */
export function providerProblem(p: AiProvider): string | null {
  if (!/^https?:\/\/\S+$/.test(p.baseUrl)) return "The address must start with https:// or http://";
  if (p.auth.kind === "env" && !ENV_NAME.test(p.auth.name)) return "Name the environment variable holding the token, e.g. OPENAI_API_KEY";
  if (p.auth.kind === "file" && !p.auth.path.trim()) return "Choose the file holding the token";
  return null;
}

/** A new provider from `preset`, with an id none of `taken` has. */
export function newProvider(preset: Preset, taken: readonly string[]): AiProvider {
  let id: string = preset.id;
  for (let n = 2; taken.includes(id); n++) id = `${preset.id}-${n}`;
  const name = id === preset.id ? preset.name : `${preset.name} ${id.slice(preset.id.length + 1)}`;
  return { id, name, preset: preset.id as PresetId, baseUrl: preset.baseUrl, auth: preset.auth };
}

/** Models worth suggesting for `capability`: the preset's, then those the provider listed. */
export const suggestions = (p: AiProvider | undefined, capability: Capability, listed: readonly string[] = []): string[] =>
  p ? [...new Set([...presetById(p.preset).models[capability], ...listed])] : [];

export interface ProvidersPort {
  /** Calls `onChange` with the providers set up now and whenever they change. */
  watch(onChange: (providers: readonly AiProvider[]) => void): Promise<() => void>;
  /** The models `provider` offers: lists them, or says why it can't be reached. */
  models(provider: AiProvider): Promise<string[]>;
}

/** The providers in the settings `watch` follows (raw, as stored), with `models` asking the backend. */
export const settingsProviders = (watch: (onChange: (raw: unknown) => void) => Promise<() => void>, models = (p: AiProvider) => commands.models(p)): ProvidersPort => ({
  watch: (onChange) => watch((raw) => onChange(parseProviders(typeof raw === "object" && raw !== null ? (raw as { providers?: unknown }).providers : undefined))),
  models,
});

/** Fixed providers, for previews and tests. */
export const memoryProviders = (providers: readonly AiProvider[] = [], models: readonly string[] = []): ProvidersPort => ({
  watch: async (onChange) => (onChange(providers), () => {}),
  models: async () => [...models],
});
