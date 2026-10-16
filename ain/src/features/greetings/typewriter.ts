import { h } from "../../sdk/dom";
import { defineGreeting, settle } from "../../sdk/greeting";
import { EASE, glancesBack } from "./motion";

export const TYPEWRITER_TEXT = "hello ♡";
const STEP_MS = 110;
const TYPED_MS = 300 + TYPEWRITER_TEXT.length * STEP_MS;
const HOLD_MS = 650;
export const TYPEWRITER_MS = TYPED_MS + HOLD_MS + TYPEWRITER_TEXT.length * 45 + 550;

/** The pill opens and types a little hello, letter by letter behind a blinking caret, then erases it. */
export const typewriter = defineGreeting({
  id: "typewriter",
  label: "Typewriter",
  async play({ island, surface, glance, size: { width, height } }) {
    const at = (ms: number) => Math.min(ms / TYPEWRITER_MS, 1);
    const letters = [...TYPEWRITER_TEXT].map((c) => h("span", { class: "typewriter-letter" }, c));
    const caret = h("span", { class: "typewriter-caret" });
    const line = h("div", { class: "typewriter", "aria-hidden": "true" }, ...letters, caret);
    surface.append(line);
    const erasedAt = (i: number) => TYPED_MS + HOLD_MS + (letters.length - 1 - i) * 45;
    try {
      await settle([
        island.animate(
          [
            { width: `${height}px`, offset: 0, easing: EASE },
            { width: `${width}px`, offset: at(300) },
            { width: `${width}px`, offset: 1 },
          ],
          { duration: TYPEWRITER_MS, fill: "backwards" },
        ),
        // Each letter appears in turn, then they go again from the last one.
        ...letters.map((letter, i) =>
          letter.animate(
            [
              { opacity: 0, offset: 0 },
              { opacity: 0, offset: at(300 + i * STEP_MS) },
              { opacity: 1, offset: at(300 + i * STEP_MS + 1) },
              { opacity: 1, offset: at(erasedAt(i)) },
              { opacity: 0, offset: at(erasedAt(i) + 1) },
              { opacity: 0, offset: 1 },
            ],
            { duration: TYPEWRITER_MS, fill: "both" },
          ),
        ),
        caret.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.51 }, { opacity: 0 }], {
          duration: 520,
          iterations: Math.floor((TYPEWRITER_MS - 400) / 520),
        }),
        ...glancesBack(glance, TYPEWRITER_MS, TYPEWRITER_MS - 450),
      ]);
    } finally {
      line.remove();
    }
  },
});
