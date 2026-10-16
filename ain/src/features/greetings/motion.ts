/** Easings the greetings share. */
export const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
export const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Keeps the glances hidden until `fromMs`, then fades them in by the end of a `totalMs` greeting. */
export const glancesBack = (glance: HTMLElement | null, totalMs: number, fromMs: number): Animation[] =>
  glance
    ? [
        glance.animate(
          [
            { opacity: 0, offset: 0 },
            { opacity: 0, offset: fromMs / totalMs },
            { opacity: 1, offset: 1 },
          ],
          { duration: totalMs, fill: "backwards" },
        ),
      ]
    : [];
