// An example pill style: copy this file into the plugins folder, turn it on in Settings → Plugins,
// then pick "Neon line" in Settings → Appearance → Pill style.
//
// A style only draws the folded island: hovering still opens it as usual, and the startup
// animation, the pill size and the colors all still apply. Like a plugin, it is an ES module whose
// default export receives the island's SDK; it returns a style (an id, a label and `mount`).

/** @param {import("../../src/sdk").Sdk} island */
export default (island) => {
  const { h } = island.dom;
  const { number, toggle } = island.options;

  return island.defineStyle({
    id: "neon-line",
    label: "Neon line",

    // Drawn under the style in Settings → Appearance; read them with `options()`.
    options: {
      thickness: number("Thickness", 4, { min: 2, max: 12, unit: "px" }),
      progress: toggle("Show progress", true, "Music and the timer fill the line as they go."),
    },

    // The folded size: as wide as the pill, as thick as chosen, both following the pill size.
    size: (pill, { thickness }) => ({ width: pill.width, height: Math.max(2, Math.round(thickness * pill.scale)) }),

    // Built once each time the style is picked; `draw` then runs every second, and whenever a
    // glance changes. Colors come from the island: --accent, --ambient (album art…), --done (alerts).
    mount(root, { options }) {
      const fill = h("i");
      const line = h("div", { "aria-hidden": "true" }, fill);
      Object.assign(line.style, { position: "absolute", inset: "0", background: "var(--track)" });
      Object.assign(fill.style, {
        display: "block",
        height: "100%",
        width: "100%",
        boxShadow: "0 0 8px currentColor",
        transition: "width 0.6s ease, background-color 0.6s ease, color 0.6s ease",
      });
      root.append(line);
      return {
        /** @param {import("../../src/sdk/style").Folded} folded */
        draw({ left, right, ambient, alert }) {
          const progress = [right, left].find((g) => g?.progress !== undefined)?.progress;
          fill.style.width = options().progress && progress !== undefined ? `${Math.round(progress * 100)}%` : "100%";
          const color = alert ? "var(--done)" : (ambient ?? "var(--accent)");
          fill.style.backgroundColor = color;
          fill.style.color = color;
        },
      };
    },
  });
};
