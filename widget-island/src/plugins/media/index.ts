import { imageColor } from "../../core/color";
import { button, h, icon } from "../../core/dom";
import { toggle } from "../../core/options";
import { definePlugin } from "../../core/plugin";
import type { Control, MediaPort, Track } from "./api";

const NOTE = `<path d="M6 12.25V3.5l7-1.5v8.75"/><circle cx="4.25" cy="12.25" r="1.75"/><circle cx="11.25" cy="10.75" r="1.75"/>`;
const PLAY = `<path d="M5.25 3.4v9.2a.6.6 0 0 0 .9.5l7.3-4.6a.6.6 0 0 0 0-1L6.15 2.9a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none"/>`;
const PAUSE = `<path d="M5.5 3.5v9M10.5 3.5v9" stroke-width="2.25"/>`;
const PREV = `<path d="M12 3.75v8.5L6 8zM4 3.5v9" fill="currentColor"/>`;
const NEXT = `<path d="M4 3.75v8.5L10 8zM12 3.5v9" fill="currentColor"/>`;
/** The pill widens while music plays, leaving room for this much of the title. */
const GLANCE_CHARS = 24;

/** Where playback is now, extrapolated from the last report while playing. */
export const position = (t: Track, now: number): number =>
  t.playing ? Math.min(t.durationMs || Infinity, t.positionMs + Math.max(0, now - t.measuredAt)) : t.positionMs;

/** 83_000 → "1:23", 3_723_000 → "1:02:03". */
export const elapsed = (ms: number): string => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const [hr, min, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return hr ? `${hr}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
};

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export const media = definePlugin({
  id: "media",
  label: "Now playing",
  description: "Whatever plays through Windows' media controls — Spotify, browsers, players — with controls.",
  icon: NOTE,
  slots: ["glance", "tab"],
  options: {
    wide: toggle("Expand the pill while playing", true, "Shows the cover and more of the title, like a live activity."),
    tint: toggle("Tint the island with the album art", true),
  },
  setup({ media: port }: { media: MediaPort }, host) {
    let track: Track | null = null;
    let artKey = "";
    let artUrl: string | null = null;
    let ambient: string | null = null;
    let shownPlaying: boolean | null = null;

    const img = h("img", { class: "art-img", alt: "" });
    img.addEventListener("load", () => {
      ambient = imageColor(img);
      host.refresh();
    });
    const cover = h("div", { class: "art", "data-has": "false" }, icon(NOTE, "icon art-fallback"), img);
    const title = h("div", { class: "media-title" });
    const sub = h("div", { class: "media-sub" });
    const at = h("span");
    const total = h("span");
    const bar = h("div", { class: "bar thin" }, h("i"));
    const act = (action: Control) => {
      if (track && action === "toggle") {
        const now = Date.now();
        track = { ...track, playing: !track.playing, positionMs: position(track, now), measuredAt: now };
        draw(now);
      }
      port.control(action).catch(() => {});
    };
    const play = button("", () => act("toggle"), { class: "round primary" });
    const prev = button(icon(PREV), () => act("previous"), { class: "round flat", "aria-label": "Previous" });
    const next = button(icon(NEXT), () => act("next"), { class: "round flat", "aria-label": "Next" });
    const body = h(
      "div",
      { class: "media" },
      cover,
      h(
        "div",
        { class: "media-main" },
        title,
        sub,
        h("div", { class: "media-progress" }, at, bar, total),
        h("div", { class: "row gap media-controls" }, prev, play, next),
      ),
    );
    const empty = h("p", { class: "empty" }, "Nothing playing");

    const draw = (now: number) => {
      body.hidden = !track;
      empty.hidden = !!track;
      if (!track) return;
      title.textContent = track.title;
      title.title = track.title;
      sub.textContent = [track.artist, track.app].filter(Boolean).join(" · ");
      const pos = position(track, now);
      at.textContent = elapsed(pos);
      total.textContent = track.durationMs ? elapsed(track.durationMs) : "";
      bar.style.setProperty("--p", String(track.durationMs ? pos / track.durationMs : 0));
      bar.dataset.live = String(track.playing);
      if (shownPlaying !== track.playing) {
        shownPlaying = track.playing;
        play.replaceChildren(icon(track.playing ? PAUSE : PLAY));
        play.setAttribute("aria-label", track.playing ? "Pause" : "Play");
      }
    };

    const showArtwork = async (key: string) => {
      artKey = key;
      const url = key ? await port.artwork().catch(() => null) : null;
      if (artKey !== key) return;
      artUrl = url;
      if (url) img.src = url;
      else {
        img.removeAttribute("src");
        ambient = null;
      }
      cover.dataset.has = String(!!url);
    };

    void port.watch((next) => {
      track = next;
      const key = next?.artworkKey ?? "";
      if (key !== artKey) void showArtwork(key);
      draw(Date.now());
      host.refresh();
    });

    return {
      panel: (root) => root.append(body, empty),
      tick: ({ visible, now }) => (visible ? draw(now) : undefined),
      glance: () =>
        track?.playing
          ? { text: clip(track.title, GLANCE_CHARS), mark: "eq", wide: host.options().wide, ...(artUrl ? { art: artUrl } : {}) }
          : null,
      ambient: () => (host.options().tint ? ambient : null),
    };
  },
});
