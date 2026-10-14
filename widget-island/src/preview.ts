/**
 * Browser preview with a fake backend: http://localhost:5173/preview.html
 *   ?open=<tab>  opens the island on that tab
 *   &run         starts the timer
 *   &notch       simulates a MacBook notch
 *   &still       disables motion (for headless screenshots)
 *   &frame=<ms>  freezes the unfold at that time; add &fold to freeze the fold instead
 *   &mic         pretends Discord is using the microphone
 *   &osd         changes the volume shortly after start, to show the pop-up
 *   &pins        pins several volume sources
 *   &pick        opens the volume tab's source list
 */
import { start } from "./app";
import { idlePopup } from "./core/commands";
import { defaults, memorySettings } from "./core/settings";
import { layout } from "./layout";
import type { Services } from "./services";
import type { WindowPort } from "./core/window";
import type { Clip } from "./plugins/clipboard/api";
import type { Track } from "./plugins/media/api";

const params = new URLSearchParams(location.search);
const t0 = Date.now();
const GB = 1024 ** 3;

let clips: Clip[] = [
  { text: "https://v2.tauri.app/start/", copiedAt: t0 - 4_000 },
  { text: "#0A84FF", copiedAt: t0 - 95_000 },
  { text: "const island = await mount(root, modules);\nexport default island;", copiedAt: t0 - 12 * 60_000 },
  { text: "hello@example.com", copiedAt: t0 - 3 * 3_600_000 },
  { text: "Ship the island widget before Friday, then polish the timer ring.", copiedAt: t0 - 26 * 3_600_000 },
];

const fakeWindow: WindowPort = {
  island: async () => ({ width: params.has("notch") ? 185 : 200, height: 32, hasNotch: params.has("notch") }),
  layout: async () => {},
};

const cover = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#1db954"/><stop offset="1" stop-color="#0a84ff"/></linearGradient></defs><rect width="80" height="80" fill="url(#g)"/><circle cx="40" cy="40" r="18" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="4"/></svg>`,
)}`;
const track: Track = {
  title: "Midnight City",
  artist: "M83",
  album: "Hurry Up, We're Dreaming",
  app: "Spotify",
  playing: true,
  positionMs: 83_000,
  durationMs: 243_000,
  measuredAt: t0,
  artworkKey: "m83",
};

const fake: Services = {
  stats: {
    stats: async () => {
      const now = Date.now();
      const t = (now - t0) / 1000;
      return {
        cpu: 38 + 22 * Math.sin(t / 1.7) + 8 * Math.random(),
        memUsed: 10.3 * GB,
        memTotal: 16 * GB,
        rxPerSec: 2.4 * 1024 ** 2 * (0.5 + Math.random()),
        txPerSec: 180 * 1024 * Math.random(),
        sampledAt: Math.floor(now / 1000) * 1000,
      };
    },
  },
  clipboard: {
    history: async () => clips,
    copyImage: async () => {},
    copy: async (text) => {
      clips = [{ text, copiedAt: Date.now() }, ...clips.filter((c) => c.text !== text)];
    },
    clear: async () => {
      clips = [];
    },
  },
  media: {
    watch: async (onChange) => (onChange(track), () => {}),
    artwork: async () => cover,
    control: async () => {},
  },
  volume: {
    watch: async (onChange) => {
      const output = { level: 0.62, muted: false, device: "Speakers (Realtek Audio)" };
      onChange(output);
      if (params.has("osd")) setTimeout(() => onChange({ ...output, level: 0.74 }), 600);
      return () => {};
    },
    watchSources: async (onChange) => {
      const src = (id: string, kind: "device" | "app", name: string, level: number, extra: { default?: boolean; active?: boolean; muted?: boolean } = {}) => ({
        id,
        kind,
        name,
        level,
        muted: extra.muted ?? false,
        default: extra.default ?? false,
        active: extra.active ?? kind === "device",
      });
      onChange([
        src("device:1", "device", "Speakers (Realtek Audio)", 0.62, { default: true }),
        src("device:2", "device", "SteelSeries Sonar - Chat (SteelSeries Sonar Virtual Audio Device)", 0.8),
        src("device:3", "device", "Headphones (Arctis Nova Pro Wireless)", 0.45),
        src("app:spotify", "app", "Spotify", 0.7, { active: true }),
        src("app:discord", "app", "Discord", 0.9, { active: true }),
        src("app:msedge", "app", "Msedge", 1, { muted: true }),
      ]);
      return () => {};
    },
    peak: async () => 0.35 + 0.4 * Math.random(),
    setLevel: async () => {},
    setMuted: async () => {},
  },
  screen: { latest: async () => null, save: async () => "" },
  privacy: {
    watch: async (onChange) => (onChange({ mic: params.has("mic") ? ["Discord"] : [], camera: [] }), () => {}),
  },
};

if (params.has("still")) {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
  document.head.append(style);
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    const base = typeof options === "object" ? options : {};
    return animate.call(this, keyframes, { ...base, duration: 0, delay: 0 });
  };
}
document.body.style.background = "radial-gradient(120% 140% at 20% 0%, #3a5a8c, #1b2335 55%, #0d1018)";

const root = document.querySelector<HTMLElement>("#island");
const store = memorySettings();
// `&pins`: pin a few sources, to see the mixer with several rows.
if (params.has("pins")) await store.save({ ...defaults(layout), options: { volume: { pinned: ["Speakers", "SteelSeries Sonar - Chat", "Spotify", "Discord"] } } });
if (root) await start(root, fake, fakeWindow, store, idlePopup);

const tab = params.get("open");
if (tab) {
  const at = (ms: number, fn: () => void) => setTimeout(fn, ms);
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  at(200, () => q("#island")?.dispatchEvent(new PointerEvent("pointerenter")));
  at(450, () => q(`#tab-${tab}`)?.click());
  if (params.has("run")) at(500, () => q("#panel-timer .primary")?.click());
  if (params.has("pick")) at(600, () => q("#panel-volume .mx-switch")?.click());

  // Freeze the unfold (or, with `fold`, the fold) at `frame` ms to inspect a single animation frame.
  const frameAt = params.get("frame");
  if (frameAt !== null) {
    const instant = document.createElement("style");
    instant.textContent = "*, *::before, *::after { transition: none !important; }";
    const seek = () => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = Number(frameAt);
      }
    };
    if (params.has("fold")) {
      document.head.append(instant);
      at(900, () => {
        instant.remove();
        q("#island")?.dispatchEvent(new PointerEvent("pointerleave"));
      });
      at(1500, seek);
    } else at(900, seek);
  }
}
