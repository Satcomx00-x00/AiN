// An example startup animation: copy this file into the plugins folder, turn it on in
// Settings → Plugins, then pick "Wave" in Settings → Appearance → Startup animation.
//
// Like a plugin, it is an ES module whose default export receives the island's SDK; it returns a
// startup animation (an id, a label and `play`) instead of a plugin.

/** @param {import("../../src/sdk").Sdk} island */
export default (island) => {
  const { h } = island.dom;
  const DURATION = 1600;

  return island.defineGreeting({
    id: "wave",
    label: "Wave",

    /** @param {import("../../src/sdk/greeting").Stage} stage */
    async play({ island: pill, surface, glance, size: { width, height } }) {
      // Elements go inside `surface`, which is clipped to the pill's shape.
      const dots = [0, 1, 2, 3, 4].map(() => h("i"));
      const row = h("div", { "aria-hidden": "true" }, ...dots);
      Object.assign(row.style, { position: "absolute", inset: "0", display: "flex", gap: "5px", alignItems: "center", justifyContent: "center" });
      for (const dot of dots) Object.assign(dot.style, { width: "5px", height: "5px", borderRadius: "50%", background: "var(--accent)" });
      surface.append(row);
      try {
        // Resolves once every animation is done (or cancelled).
        await island.settle([
          // `fill: "backwards"`: once done, the pill's own style takes over again.
          pill.animate(
            [
              { width: `${height}px`, offset: 0 },
              { width: `${width}px`, offset: 0.25, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
              { width: `${width}px`, offset: 1 },
            ],
            { duration: DURATION, fill: "backwards" },
          ),
          ...dots.map((dot, i) =>
            dot.animate(
              [
                { transform: "translateY(0)", opacity: 0 },
                { transform: "translateY(-6px)", opacity: 1, offset: 0.3 + i * 0.06 },
                { transform: "translateY(0)", opacity: 1, offset: 0.45 + i * 0.06 },
                { transform: "translateY(0)", opacity: 0 },
              ],
              { duration: DURATION, fill: "both" },
            ),
          ),
          // Keep the usual glances hidden until the end.
          ...(glance ? [glance.animate([{ opacity: 0 }, { opacity: 0, offset: 0.8 }, { opacity: 1 }], { duration: DURATION, fill: "backwards" })] : []),
        ]);
      } finally {
        row.remove();
      }
    },
  });
};
