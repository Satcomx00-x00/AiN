import { h } from "../sdk/dom";
import type { Size } from "./window";

/** The whole greeting, in ms. */
export const HELLO_MS = 2300;

const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * The pill says hello when the island starts: a drop falls from the top of the screen, stretches
 * into the pill with a little wobble, and a face appears in it, blinks, looks around, hops, and
 * gives way to the usual glances. Resolves once done; skipped (resolving at once) when `motion`
 * is off, e.g. for users who ask the system for reduced motion.
 */
export async function hello(island: HTMLElement, size: Size, motion: boolean): Promise<void> {
  if (!motion) return;
  const { width, height } = size;
  const glance = island.querySelector<HTMLElement>(".glance");
  const face = h("div", { class: "hello-face", "aria-hidden": "true" }, h("i", { class: "eye" }), h("i", { class: "eye" }), h("i", { class: "cheek" }), h("i", { class: "cheek" }));
  island.querySelector(".surface")?.append(face);
  const eyes = [...face.querySelectorAll<HTMLElement>(".eye")];
  const cheeks = [...face.querySelectorAll<HTMLElement>(".cheek")];
  const at = (ms: number) => ms / HELLO_MS;

  const animations = [
    // The drop falls from above the screen's edge, then stretches into the pill and wobbles.
    island.animate(
      [
        { width: `${height}px`, transform: "translateY(-110%) scaleY(1.15)", offset: 0, easing: "cubic-bezier(0.5, 0, 0.75, 0)" },
        { width: `${height}px`, transform: "translateY(0) scaleY(0.8)", offset: at(380), easing: SPRING },
        { width: `${height}px`, transform: "translateY(0) scaleY(1)", offset: at(520), easing: EASE },
        { width: `${width * 1.08}px`, transform: "scaleY(0.88)", offset: at(820), easing: EASE },
        { width: `${width * 0.97}px`, transform: "scaleY(1.04)", offset: at(980), easing: EASE },
        { width: `${width}px`, transform: "none", offset: at(1120) },
        // A little happy hop before the face goes.
        { width: `${width}px`, transform: "none", offset: at(1600), easing: "ease-out" },
        { width: `${width}px`, transform: "translateY(2px) scaleY(0.92)", offset: at(1680), easing: SPRING },
        { width: `${width}px`, transform: "none", offset: at(1860) },
        { width: `${width}px`, transform: "none", offset: 1 },
      ],
      { duration: HELLO_MS, fill: "backwards" },
    ),
    // The face: eyes open, blink, look left then right, close happily, and fade.
    ...eyes.map((eye) =>
      eye.animate(
        [
          { opacity: 0, transform: "scale(0)", offset: 0 },
          { opacity: 0, transform: "scale(0)", offset: at(700), easing: SPRING },
          { opacity: 1, transform: "scale(1)", offset: at(900) },
          { transform: "scaleY(1)", offset: at(1040) },
          { transform: "scaleY(0.1)", offset: at(1100) },
          { transform: "scaleY(1)", offset: at(1170) },
          { transform: "translateX(-3px)", offset: at(1260), easing: EASE },
          { transform: "translateX(-3px)", offset: at(1400), easing: EASE },
          { transform: "translateX(3px)", offset: at(1500), easing: EASE },
          { transform: "translateX(0) scaleY(1)", offset: at(1600) },
          // Happy squint during the hop.
          { transform: "scaleY(0.35)", offset: at(1700) },
          { opacity: 1, transform: "scaleY(0.35)", offset: at(1900) },
          { opacity: 0, transform: "scaleY(0.35)", offset: at(2100) },
          { opacity: 0, transform: "scaleY(0.35)", offset: 1 },
        ],
        { duration: HELLO_MS, fill: "both" },
      ),
    ),
    ...cheeks.map((cheek) =>
      cheek.animate(
        [
          { opacity: 0, offset: 0 },
          { opacity: 0, offset: at(1000) },
          { opacity: 0.85, offset: at(1250) },
          { opacity: 0.85, offset: at(1900) },
          { opacity: 0, offset: at(2100) },
          { opacity: 0, offset: 1 },
        ],
        { duration: HELLO_MS, fill: "both" },
      ),
    ),
    // The usual glances come back once the face is gone.
    ...(glance
      ? [
          glance.animate(
            [
              { opacity: 0, offset: 0 },
              { opacity: 0, offset: at(2050) },
              { opacity: 1, offset: 1 },
            ],
            { duration: HELLO_MS, fill: "backwards" },
          ),
        ]
      : []),
  ];

  try {
    await Promise.all(animations.map((a) => a.finished));
  } catch {
    // Cancelled: the island is going away or was reset; nothing to finish.
  } finally {
    face.remove();
  }
}
