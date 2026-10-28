import { commands } from "./bindings/providers";

/** Whose options hold the provider and model plugins may ask; the backend reads the same. */
export const PLUGIN_AI = "plugin-ai";

export interface AskOptions {
  /** How the model should answer: its role, the format, the language… */
  readonly instructions?: string;
}

/**
 * What the `ai` service does for a plugin: asks the model the user picked for plugins in
 * Settings → AI providers. Off until they pick one: `ask` then fails, saying where to turn it on.
 * At most 4 000 characters of instructions and 32 000 of text.
 */
export interface AiPort {
  /** The model's answer to `text`. */
  ask(text: string, options?: AskOptions): Promise<string>;
}

export const tauriAi: AiPort = { ask: (text, options = {}) => commands.ask(options.instructions ?? "", text) };

/** No model, for the browser previews. */
export const noAi: AiPort = { ask: () => Promise.reject(new Error("AI is only available in the app")) };
