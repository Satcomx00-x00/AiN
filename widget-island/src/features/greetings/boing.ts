import { defineGreeting, settle } from "../../sdk/greeting";
import { EASE, SPRING, glancesBack } from "./motion";

export const BOING_MS = 1700;

/** A drop bounces in from the top of the screen, three times smaller each time, then springs wide. */
export const boing = defineGreeting({
  id: "boing",
  label: "Boing",
  async play({ island, glance, size: { width, height } }) {
    const at = (ms: number) => ms / BOING_MS;
    const drop = (y: string, squash: number, ms: number, easing: string) => ({
      width: `${height}px`,
      transform: `translateY(${y}) scale(${1 / squash}, ${squash})`,
      offset: at(ms),
      easing,
    });
    const fall = "cubic-bezier(0.55, 0, 1, 0.45)";
    const rise = "cubic-bezier(0, 0.55, 0.45, 1)";
    await settle([
      island.animate(
        [
          { ...drop("-110%", 1.2, 0, fall), offset: 0 },
          drop("0", 0.7, 340, rise),
          drop("-45%", 1.1, 520, fall),
          drop("0", 0.8, 700, rise),
          drop("-18%", 1, 820, fall),
          drop("0", 0.9, 940, EASE),
          { width: `${height}px`, transform: "none", offset: at(1020), easing: SPRING },
          { width: `${width}px`, transform: "none", offset: at(1400) },
          { width: `${width}px`, transform: "none", offset: 1 },
        ],
        { duration: BOING_MS, fill: "backwards" },
      ),
      ...glancesBack(glance, BOING_MS, 1350),
    ]);
  },
});
