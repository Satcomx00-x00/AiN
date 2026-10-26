import type { Page } from "@playwright/test";

/** What the stand-in backend starts with: stored settings, as the app keeps them on disk. */
export interface Backend {
  readonly settings?: unknown;
}

/** What the page asked the backend, read back after the fact. */
export interface Calls {
  readonly commands: { cmd: string; args: unknown }[];
  /** Commands the stand-in doesn't know: the page called something new, or misspelled one. */
  readonly unknown: string[];
}

/**
 * A stand-in for the Tauri backend, installed before the page's own scripts run: answers every
 * command the frontend uses with plausible data, delivers events, and records the calls. It runs in
 * the page, so it is self-contained.
 */
function install(backend: Backend): void {
  type Callback = (message: unknown) => void;
  const callbacks = new Map<number, Callback>();
  const listeners = new Map<string, { id: number; handler: number }[]>();
  let next = 1;
  let settings: unknown = backend.settings ?? null;
  const calls = { commands: [] as { cmd: string; args: unknown }[], unknown: [] as string[] };
  const emit = (event: string, payload: unknown) => {
    for (const l of listeners.get(event) ?? []) callbacks.get(l.handler)?.({ event, id: l.id, payload });
  };
  const now = () => Date.now();
  const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
    "plugin:event|listen": (a) => {
      const id = next++;
      const list = listeners.get(a.event as string) ?? [];
      list.push({ id, handler: a.handler as number });
      listeners.set(a.event as string, list);
      return id;
    },
    "plugin:event|unlisten": () => null,
    "plugin:island|info": () => ({ width: 200, height: 32, hasNotch: false }),
    "plugin:island|layout": () => null,
    "plugin:island|auto_hide": () => null,
    "plugin:settings|get": () => settings,
    "plugin:settings|set": (a) => {
      settings = a.value;
      emit("plugin:settings:settings-changed", settings);
      return null;
    },
    "plugin:settings|open": () => null,
    "plugin:settings|quit": () => null,
    "plugin:settings|play_greeting": () => null,
    "plugin:settings|autostart": () => false,
    "plugin:settings|set_autostart": () => null,
    "plugin:stats|latest": () => ({ cpu: 42, memUsed: 8e9, memTotal: 16e9, rxPerSec: 1024, txPerSec: 512, sampledAt: now() }),
    "plugin:clipboard|history": () => [{ text: "hello from the clipboard", copiedAt: now() - 5000 }],
    "plugin:clipboard|copy": () => null,
    "plugin:clipboard|copy_image": () => null,
    "plugin:clipboard|clear": () => null,
    "plugin:media|state": () => null,
    "plugin:media|artwork": () => null,
    "plugin:media|control": () => null,
    "plugin:volume|state": () => ({ level: 0.5, muted: false, device: "Speakers" }),
    "plugin:volume|sources": () => [],
    "plugin:volume|peak": () => 0,
    "plugin:volume|set_level": () => null,
    "plugin:volume|set_muted": () => null,
    "plugin:privacy|state": () => ({ mic: [], camera: [] }),
    "plugin:dictation|state": () => ({ phase: "idle" }),
    "plugin:dictation|model_status": () => ({ model: "parakeet-v3", dir: "/models", installed: ["parakeet-v3"], state: "ready" }),
    "plugin:dictation|microphones": () => [],
    "plugin:dictation|control": () => null,
    "plugin:dictation|download_model": () => null,
    "plugin:dictation|delete_model": () => null,
    "plugin:dictation|open_model_dir": () => null,
    "plugin:tts|state": () => ({ phase: "idle" }),
    "plugin:tts|model_status": () => ({ model: "kokoro-en", dir: "/models", installed: ["kokoro-en"], state: "ready" }),
    "plugin:tts|control": () => null,
    "plugin:tts|speak": () => null,
    "plugin:tts|download_model": () => null,
    "plugin:tts|delete_model": () => null,
    "plugin:tts|open_model_dir": () => null,
    "plugin:persona|state": () => ({ phase: "idle" }),
    "plugin:persona|control": () => null,
    "plugin:persona|local_status": () => ({ dir: "/models/personaplex", running: false, state: "missing" }),
    "plugin:persona|install_local": () => null,
    "plugin:persona|remove_local": () => null,
    "plugin:persona|open_local_dir": () => null,
    "plugin:secrets|saved_keys": (a) => (a.keys as string[]).map(() => false),
    "plugin:capture|latest": () => new ArrayBuffer(0),
    "plugin:capture|save_png": () => "/Pictures/AiN/capture.png",
    "plugin:extensions|list": () => ({ dir: "/plugins", plugins: [] }),
    "plugin:extensions|open_dir": () => null,
    "plugin:store|catalog": () => ({
      url: "https://store.test/store.yaml",
      plugins: [{ id: "orbit-clock", name: "Orbit clock", description: "An analog clock.", repo: "https://github.com/o/r", file: "orbit-clock/index.js", problem: null }],
    }),
    "plugin:store|install": () => "orbit-clock/index.js",
    "plugin:store|open_repo": () => null,
    "plugin:popup|bind": () => ({}),
    "plugin:popup|failures": () => ({}),
    "plugin:popup|open": () => null,
    "plugin:popup|hide": () => null,
    "plugin:popup|paste": () => null,
    "plugin:updates|status": () => ({ current: "0.2.0", state: { kind: "upToDate" }, releases: "https://github.com/Satcomx00-x00/AiN/releases" }),
    "plugin:updates|check": () => ({ current: "0.2.0", state: { kind: "upToDate" }, releases: "https://github.com/Satcomx00-x00/AiN/releases" }),
    "plugin:updates|install": () => null,
    "plugin:updates|open_releases": () => null,
  };
  Object.assign(window, {
    __smoke: calls,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "smoke" }, currentWebview: { windowLabel: "smoke", label: "smoke" } },
      transformCallback: (callback: Callback, once = false) => {
        const id = next++;
        callbacks.set(id, (m) => {
          if (once) callbacks.delete(id);
          callback(m);
        });
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (path: string) => path,
      invoke: async (cmd: string, args: unknown) => {
        calls.commands.push({ cmd, args });
        const answer = answers[cmd];
        if (!answer) {
          calls.unknown.push(cmd);
          return null;
        }
        return answer((args ?? {}) as Record<string, unknown>);
      },
    },
  });
}

/** Installs the stand-in backend in `page`; it applies to every page load from now on. */
export async function withBackend(page: Page, backend: Backend = {}): Promise<void> {
  await page.addInitScript(install, backend);
}

/** What the page has asked the backend so far. */
export const calls = (page: Page): Promise<Calls> => page.evaluate(() => (window as unknown as { __smoke: Calls }).__smoke);
