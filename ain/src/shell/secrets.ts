import { commands, events } from "./bindings/secrets";

/**
 * Plugins' secrets (API keys, tokens), kept by the backend in the system's credential store rather
 * than in the settings. Settings saves them and asks which are saved; only the island reads them.
 */
export interface SecretsPort {
  /** A plugin's secret, or null when none is saved. */
  get(plugin: string, key: string): Promise<string | null>;
  /** Saves it; an empty value removes it. */
  set(plugin: string, key: string, value: string): Promise<void>;
  /** Which of `keys` have a secret saved, in order, without reading them out. */
  saved(plugin: string, keys: readonly string[]): Promise<boolean[]>;
  /** Calls back when a secret changes; resolves with a function that stops listening. */
  onChange(listener: (plugin: string, key: string) => void): Promise<() => void>;
}

export const tauriSecrets: SecretsPort = {
  get: (plugin, key) => commands.get(plugin, key),
  set: async (plugin, key, value) => void (await commands.set(plugin, key, value)),
  saved: (plugin, keys) => commands.savedKeys(plugin, [...keys]),
  onChange: (listener) => events.secretChanged.listen((e) => listener(e.payload.plugin, e.payload.key)),
};

/** Secrets in memory: for the browser preview, and shared by the island and Settings in tests. */
export function memorySecrets(): SecretsPort {
  const kept = new Map<string, string>();
  const listeners = new Set<(plugin: string, key: string) => void>();
  const at = (plugin: string, key: string) => `${plugin}/${key}`;
  return {
    get: async (plugin, key) => kept.get(at(plugin, key)) ?? null,
    set: async (plugin, key, value) => {
      const trimmed = value.trim();
      if (trimmed) kept.set(at(plugin, key), trimmed);
      else kept.delete(at(plugin, key));
      for (const l of listeners) l(plugin, key);
    },
    saved: async (plugin, keys) => keys.map((key) => kept.has(at(plugin, key))),
    onChange: async (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * Reads secrets for the island's plugins, once each until they change: a plugin may ask for one
 * on every tick. A failed read resolves to "" (and is logged), and is tried again next time.
 */
export function secretReader(port: SecretsPort, log: (message: string) => void = console.error) {
  const cache = new Map<string, Promise<string>>();
  const at = (plugin: string, key: string) => `${plugin}/${key}`;
  void port.onChange((plugin, key) => cache.delete(at(plugin, key))).catch((e: unknown) => log(`[island] can't follow secret changes: ${String(e)}`));
  return (plugin: string, key: string): Promise<string> => {
    const known = cache.get(at(plugin, key));
    if (known) return known;
    const read = port.get(plugin, key).then(
      (v) => v ?? "",
      (e: unknown) => {
        cache.delete(at(plugin, key));
        log(`[island] plugin "${plugin}" can't read its secret "${key}": ${String(e)}`);
        return "";
      },
    );
    cache.set(at(plugin, key), read);
    return read;
  };
}
