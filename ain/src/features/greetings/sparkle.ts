import { h, svg } from "../../sdk/dom";
import { defineGreeting, settle } from "../../sdk/greeting";
import { EASE, SPRING, glancesBack } from "./motion";

export const SPARKLE_MS = 2000;

/** Where the stars twinkle, as fractions of the pill, and when (ms). */
const STARS: readonly { x: number; y: number; size: number; at: number }[] = [
  { x: 0.18, y: 0.3, size: 9, at: 450 },
  { x: 0.82, y: 0.62, size: 11, at: 560 },
  { x: 0.42, y: 0.68, size: 7, at: 680 },
  { x: 0.64, y: 0.28, size: 10, at: 780 },
  { x: 0.3, y: 0.55, size: 6, at: 900 },
  { x: 0.92, y: 0.3, size: 7, at: 1000 },
  { x: 0.55, y: 0.5, size: 12, at: 1120 },
];

/** A four-pointed star. */
const STAR = `<path d="M5 0 6.2 3.8 10 5 6.2 6.2 5 10 3.8 6.2 0 5 3.8 3.8Z"/>`;

/** The pill unfolds from its middle while little stars twinkle all over it. */
export const sparkle = defineGreeting({
  id: "sparkle",
  label: "Sparkle",
  async play({ island, surface, glance, size: { width, height }, scale }) {
    const at = (ms: number) => ms / SPARKLE_MS;
    const sky = h("div", { class: "sparkle-sky", "aria-hidden": "true" });
    const stars = STARS.map(({ x, y, size }) => {
      const star = h("span", { class: "sparkle-star" }, svg("0 0 10 10", STAR));
      Object.assign(star.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${size * scale}px`, height: `${size * scale}px` });
      sky.append(star);
      return star;
    });
    surface.append(sky);
    try {
      await settle([
        island.animate(
          [
            { width: `${height}px`, opacity: 0, transform: "scale(0.6)", offset: 0, easing: SPRING },
            { width: `${height}px`, opacity: 1, transform: "none", offset: at(260), easing: EASE },
            { width: `${width}px`, opacity: 1, transform: "none", offset: at(700) },
            { width: `${width}px`, opacity: 1, transform: "none", offset: 1 },
          ],
          { duration: SPARKLE_MS, fill: "backwards" },
        ),
        ...stars.map((star, i) => {
          const start = STARS[i]!.at;
          return star.animate(
            [
              { opacity: 0, transform: "translate(-50%, -50%) scale(0) rotate(0deg)", offset: 0 },
              { opacity: 0, transform: "translate(-50%, -50%) scale(0) rotate(0deg)", offset: at(start), easing: SPRING },
              { opacity: 1, transform: "translate(-50%, -50%) scale(1) rotate(90deg)", offset: at(start + 260), easing: EASE },
              { opacity: 0, transform: "translate(-50%, -50%) scale(0.2) rotate(180deg)", offset: at(start + 620) },
              { opacity: 0, transform: "translate(-50%, -50%) scale(0) rotate(180deg)", offset: 1 },
            ],
            { duration: SPARKLE_MS, fill: "both" },
          );
        }),
        ...glancesBack(glance, SPARKLE_MS, 1650),
      ]);
    } finally {
      sky.remove();
    }
  },
});
