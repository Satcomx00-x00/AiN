import { h } from "../../sdk/dom";
import { defineGreeting, settle } from "../../sdk/greeting";
import { EASE, SPRING, glancesBack } from "./motion";

/** The whole greeting, in ms. */
export const HELLO_MS = 2300;

/**
 * A drop falls from the top of the screen and stretches into the pill with a little wobble; a face
 * appears in it, blinks, looks around, blushes and hops, then gives way to the glances.
 */
export const hello = defineGreeting({
  id: "hello",
  label: "Hello",
  async play({ island, surface, glance, size: { width, height }, scale }) {
    const face = h("div", { class: "hello-face", "aria-hidden": "true" }, h("i", { class: "eye" }), h("i", { class: "eye" }), h("i", { class: "cheek" }), h("i", { class: "cheek" }));
    surface.append(face);
    const at = (ms: number) => ms / HELLO_MS;
    try {
      await settle([
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
            { width: `${width}px`, transform: `translateY(${2 * scale}px) scaleY(0.92)`, offset: at(1680), easing: SPRING },
            { width: `${width}px`, transform: "none", offset: at(1860) },
            { width: `${width}px`, transform: "none", offset: 1 },
          ],
          { duration: HELLO_MS, fill: "backwards" },
        ),
        // Eyes open, blink, look left then right, squint happily, and fade.
        ...[...face.querySelectorAll<HTMLElement>(".eye")].map((eye) =>
          eye.animate(
            [
              { opacity: 0, transform: "scale(0)", offset: 0 },
              { opacity: 0, transform: "scale(0)", offset: at(700), easing: SPRING },
              { opacity: 1, transform: "scale(1)", offset: at(900) },
              { transform: "scaleY(1)", offset: at(1040) },
              { transform: "scaleY(0.1)", offset: at(1100) },
              { transform: "scaleY(1)", offset: at(1170) },
              { transform: `translateX(${-3 * scale}px)`, offset: at(1260), easing: EASE },
              { transform: `translateX(${-3 * scale}px)`, offset: at(1400), easing: EASE },
              { transform: `translateX(${3 * scale}px)`, offset: at(1500), easing: EASE },
              { transform: "translateX(0) scaleY(1)", offset: at(1600) },
              { transform: "scaleY(0.35)", offset: at(1700) },
              { opacity: 1, transform: "scaleY(0.35)", offset: at(1900) },
              { opacity: 0, transform: "scaleY(0.35)", offset: at(2100) },
              { opacity: 0, transform: "scaleY(0.35)", offset: 1 },
            ],
            { duration: HELLO_MS, fill: "both" },
          ),
        ),
        ...[...face.querySelectorAll<HTMLElement>(".cheek")].map((cheek) =>
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
        ...glancesBack(glance, HELLO_MS, 2050),
      ]);
    } finally {
      face.remove();
    }
  },
});
