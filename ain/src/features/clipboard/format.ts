import { h, icon } from "../../sdk/dom";
import type { Clip } from "./service";

export type Kind = "url" | "email" | "color" | "number" | "code" | "text";

const COLOR = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([\d\s.,%/]+\))$/i;

export const kindOf = (text: string): Kind => {
  const s = text.trim();
  if (COLOR.test(s)) return "color";
  if (/^https?:\/\/\S+$/i.test(s)) return "url";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "email";
  if (/^[-+]?[\d\s.,]+$/.test(s) && /\d/.test(s)) return "number";
  if (s.includes("\n") && /[{};=<>()]/.test(s)) return "code";
  return "text";
};

export const preview = (text: string, max = 80): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export const ago = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};

const KIND_ICON: Record<Exclude<Kind, "color">, string> = {
  url: `<path d="M6.75 9.25l2.5-2.5M7.25 4.75l.9-.9a2.5 2.5 0 0 1 3.5 3.5l-.9.9M8.75 11.25l-.9.9a2.5 2.5 0 0 1-3.5-3.5l.9-.9"/>`,
  email: `<circle cx="8" cy="8" r="2.25"/><path d="M10.25 8v.9a1.85 1.85 0 0 0 3.7 0V8a5.95 5.95 0 1 0-2.3 4.7"/>`,
  number: `<path d="M6.25 2.75l-1.5 10.5M11.25 2.75l-1.5 10.5M3.25 6h10M2.75 10h10"/>`,
  code: `<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>`,
  text: `<path d="M3 4.5h10M3 8h10M3 11.5h6"/>`,
};

/** A small square telling what a clip is: a color swatch, or an icon for links, code, numbers… */
export const badge = (text: string) => {
  const kind = kindOf(text);
  if (kind !== "color") return h("span", { class: "badge" }, icon(KIND_ICON[kind]));
  const swatch = h("span", { class: "badge swatch" });
  swatch.style.background = text.trim();
  return swatch;
};

/** What a clip is, in words: its text, or the size of its image. */
export const describe = (clip: Clip, max = 80): string => (clip.image ? `Image · ${clip.image.width} × ${clip.image.height}` : preview(clip.text, max));

/** A clip's mark: the image itself, small, or the badge of its text. */
export const mark = (clip: Clip): HTMLElement =>
  clip.image ? h("img", { class: "thumb", src: clip.image.thumb, alt: "", draggable: "false" }) : badge(clip.text);
