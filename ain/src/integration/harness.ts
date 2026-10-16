/**
 * Runs the island, and its settings page, for real against a fake system: services whose data a
 * test pushes, a window that records what it is asked to do, the in-memory settings store, a
 * shortcut popup that accepts every binding, and a plugins folder the test fills. Time is fake:
 * tests move the clock themselves with `advance`.
 */
import { vi } from "vitest";
import type { Sdk } from "../sdk";
import type { Services } from "../features/services";
import type { Clip } from "../features/clipboard/service";
import type { ModelInfo, Phase } from "../features/dictation/service";
import type { Control, Track } from "../features/media/service";
import type { Usage } from "../features/privacy/service";
import type { Stats } from "../features/stats/service";
import type { Output, Source } from "../features/volume/service";
import type { PopupPort } from "../shell/commands";
import type { ExtensionsPort, Importer } from "../shell/extensions";
import type { IslandHandle } from "../shell/host";
import { type Settings, defaults, memorySettings, parseSettings } from "../shell/settings";
import type { Size, WindowPort } from "../shell/window";
import { layout } from "../features/layout";

/** 9:41 on a weekday: the clock shows "09:41". */
export const NOW = new Date(2026, 9, 16, 9, 41, 0).getTime();

/** A value services push to whoever watches it, now and on every change. */
function channel<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(v: T) => void>();
  return {
    watch: async (onChange: (v: T) => void) => {
      listeners.add(onChange);
      onChange(value);
      return () => void listeners.delete(onChange);
    },
    push(next: T) {
      value = next;
      for (const l of listeners) l(next);
    },
  };
}

export const TRACK: Track = {
  title: "Midnight City",
  artist: "M83",
  album: "Hurry Up, We're Dreaming",
  app: "Spotify",
  playing: true,
  positionMs: 83_000,
  durationMs: 243_000,
  measuredAt: NOW,
  artworkKey: "m83",
};

const READY: ModelInfo = { model: "parakeet-v3", dir: "/models", installed: ["parakeet-v3"], state: "ready" } as ModelInfo;

/** A plugin file's definition, as its default export would build it from the SDK. */
export type Definition = (island: Sdk) => unknown;

/** A fresh fake system. */
export function system() {
  const media = channel<Track | null>(null);
  const output = channel<Output | null>({ level: 0.5, muted: false, device: "Speakers" } as Output);
  const sources = channel<Source[]>([]);
  const usage = channel<Usage | null>({ mic: [], camera: [] });
  const phase = channel<Phase>({ phase: "idle" });
  const model = channel<ModelInfo>(READY);
  let sample: Stats | null = { cpu: 42, memUsed: 8e9, memTotal: 16e9, rxPerSec: 0, txPerSec: 0, sampledAt: NOW };
  let clips: Clip[] = [];
  const controls: Control[] = [];

  const services: Services = {
    stats: { stats: async () => sample && { ...sample, sampledAt: Date.now() } },
    clipboard: {
      history: async () => clips,
      copy: async (text) => void (clips = [{ text, copiedAt: Date.now() }, ...clips.filter((c) => c.text !== text)]),
      copyImage: async () => {},
      clear: async () => void (clips = []),
    },
    media: { watch: media.watch, artwork: async () => null, control: async (c) => void controls.push(c) },
    volume: { watch: output.watch, watchSources: sources.watch, peak: async () => 0, setLevel: async () => {}, setMuted: async () => {} },
    privacy: { watch: usage.watch },
    capture: { latest: async () => null, save: async () => "" },
    dictation: {
      watch: phase.watch,
      watchModel: model.watch,
      openFolder: async () => {},
      microphones: async () => [],
      control: async () => {},
      download: async () => {},
      remove: async () => {},
    },
  };

  // The window: what the island asks of it, and the auto-hide rule's reveals.
  const regions: Size[] = [];
  const canvases: Size[] = [];
  const rules: [number | null, number][] = [];
  let reveal: (shown: boolean) => void = () => {};
  let hardware = { width: 200, height: 32, hasNotch: false };
  const window: WindowPort = {
    island: async () => hardware,
    layout: async (canvas, region) => {
      canvases.push(canvas);
      regions.push(region);
    },
    autoHide: async (dwell, grace) => void rules.push([dwell, grace]),
    onReveal: async (onReveal) => ((reveal = onReveal), () => {}),
  };

  const bound: Record<string, unknown>[] = [];
  const popup: PopupPort = {
    bind: async (b) => (bound.push(b), {}),
    watchFailures: async (onChange) => (onChange({}), () => {}),
    open: async () => {},
    hide: async () => {},
    paste: async () => {},
    onShow: async () => () => {},
  };

  // The plugins folder: each file's source is its name, and the importer hands back its definition.
  const files = new Map<string, Definition>();
  const folder: ExtensionsPort = {
    list: async () => ({ dir: "/plugins", plugins: [...files.keys()].map((file) => ({ file, source: file, problem: null })) }),
    openDir: async () => {},
  };
  const importer: Importer = async (source) => {
    const def = files.get(source);
    if (!def) throw new Error(`no such plugin file: ${source}`);
    return { default: def };
  };

  const store = memorySettings();
  const fallback = defaults(layout);
  // The clock's default format follows the machine's locale ("09:41" or "09:41 AM"): pin it, so
  // the tests read the same everywhere. A test that changes it still can.
  void store.save({ ...fallback, options: { clock: { format: "24" } } });

  return {
    services,
    window,
    popup,
    store,
    folder,
    importer,
    /** What the system says: push a track, an output volume, mic/camera use, a dictation phase, a stats sample. */
    push: {
      track: (t: Track | null) => media.push(t),
      output: (o: Output | null) => output.push(o),
      usage: (u: Usage | null) => usage.push(u),
      phase: (p: Phase) => phase.push(p),
      stats: (s: Partial<Stats> | null) => void (sample = s && sample ? { ...sample, ...s } : null),
    },
    recorded: { regions, canvases, rules, bound, controls },
    /** Shows or hides the pill, as the backend's auto-hide rule would. */
    reveal: (shown: boolean) => reveal(shown),
    /** The hardware island: e.g. a MacBook notch. Set before the island starts. */
    hardware: (h: { width: number; height: number; hasNotch: boolean }) => void (hardware = h),
    /** Puts a plugin file in the folder (it runs only once turned on in the settings). */
    addFile: (file: string, def: Definition) => void files.set(file, def),
    /** The stored settings, read back as the island would read them. */
    settings: async (): Promise<Settings> => {
      let raw: unknown = null;
      const stop = await store.watch((r) => (raw = r));
      stop();
      return parseSettings(raw, fallback);
    },
    /** Saves settings changed from the defaults (or from what is stored), as the settings page would. */
    save: async (change: (s: Settings) => Settings) => {
      let raw: unknown = null;
      const stop = await store.watch((r) => (raw = r));
      stop();
      await store.save(change(parseSettings(raw, fallback)));
    },
  };
}

export type System = ReturnType<typeof system>;

/** Moves the fake clock on, running every timer and promise due meanwhile. */
export const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/**
 * Fakes time and the browser bits the fake DOM lacks: Web Animations finish at once (and are
 * recorded), and the user may ask for reduced motion.
 */
export function environment({ reducedMotion = false } = {}) {
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches: reducedMotion && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  );
  const animations: { el: Element; keyframes: Keyframe[] }[] = [];
  vi.spyOn(Element.prototype, "animate").mockImplementation(function (this: Element, keyframes) {
    animations.push({ el: this, keyframes: (keyframes ?? []) as Keyframe[] });
    return { finished: Promise.resolve(), cancel() {}, finish() {}, addEventListener() {} } as unknown as Animation;
  });
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
  history.replaceState(null, "", "/");
  return { animations };
}

/** Undoes `environment`. */
export function restore() {
  vi.useRealTimers();
  vi.restoreAllMocks();
}

export interface Island {
  readonly el: HTMLElement;
  readonly handle: IslandHandle<Services>;
  /** The text of each glance spot, as drawn. */
  glances(): string[];
  /** The mark of each glance spot ("" for none). */
  marks(): string[];
  /** The pill's size as the island set it. */
  size(): { width: string; height: string };
  hover(): Promise<void>;
  leave(): Promise<void>;
}

/** Starts the island in the page, as its window does. */
export async function startIsland(sys: System): Promise<Island> {
  const { start } = await import("../shell/windows/island/app");
  const el = document.createElement("div");
  el.id = "island";
  document.body.append(el);
  const handle = await start(el, sys.services, sys.window, sys.store, sys.popup, sys.folder, sys.importer);
  await advance(0);
  return {
    el,
    handle,
    glances: () => [...el.querySelectorAll(".glance .g-text")].map((t) => t.textContent ?? ""),
    marks: () => [...el.querySelectorAll<HTMLElement>(".glance .mark")].map((m) => m.dataset.kind ?? ""),
    size: () => ({ width: el.style.getPropertyValue("--w"), height: el.style.getPropertyValue("--h") }),
    hover: async () => {
      el.dispatchEvent(new PointerEvent("pointerenter"));
      await advance(1000);
    },
    leave: async () => {
      el.dispatchEvent(new PointerEvent("pointerleave"));
      await advance(1000);
    },
  };
}

/**
 * Loads the settings page in the same document, on the same settings store and plugins folder as
 * the island, so a change made there reaches the island as it would through the app.
 */
export async function startSettings(sys: System, at = "") {
  history.replaceState(null, "", at ? `/#${at}` : "/");
  // The page sets itself up when its module loads: load a fresh copy, reading the ports given here.
  vi.resetModules();
  const ports = await import("../shell/windows/settings/ports");
  ports.usePorts({ store: sys.store, popup: sys.popup, folder: sys.folder, importer: sys.importer, inApp: false });
  await import("../shell/windows/settings/main");
  await advance(0);
  const page = document.querySelector<HTMLElement>(".app")!;
  const nav = (label: string) => [...page.querySelectorAll<HTMLButtonElement>("nav button")].find((b) => b.textContent?.trim() === label);
  return {
    page,
    /** Opens a section from the side menu. */
    open: async (label: string) => {
      nav(label)?.click();
      await advance(0);
    },
    /** A field of the current section, by its label. */
    field: (label: string) =>
      [...page.querySelectorAll<HTMLElement>(".field")].find((f) => f.querySelector(".field-label")?.textContent?.trim() === label) ?? null,
    /** Waits until the page has saved what was changed. */
    saved: () => advance(400),
  };
}

/** Clicks the button whose text is `label` inside `root`. */
export function press(root: ParentNode, label: string): void {
  const target = [...root.querySelectorAll<HTMLElement>("button, [role=radio], [role=option]")].find((b) => b.textContent?.trim() === label);
  if (!target) throw new Error(`no button "${label}"`);
  target.click();
}

/** Picks the option named `label` in the drop-down list inside `root`. */
export function pick(root: ParentNode, label: string): void {
  const options = [...root.querySelectorAll<HTMLElement>(".ui-select-option")];
  const target = options.find((o) => o.querySelector(".ui-select-label")?.childNodes[0]?.textContent?.trim() === label);
  if (!target) throw new Error(`no option "${label}" among ${options.map((o) => o.textContent).join(", ")}`);
  root.querySelector<HTMLElement>(".ui-select-trigger")?.click();
  target.click();
}
