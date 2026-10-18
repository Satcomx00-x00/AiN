// An example plugin for the island: copy this file into the plugins folder (Settings → Plugins →
// "Plugins folder" → Open), then turn it on in Settings → Plugins.
//
// A plugin is an ES module whose default export receives the island's SDK and returns a plugin
// definition. It runs as-is: no build step, no imports.

/** @param {import("../../src/sdk").Sdk} island */
export default (island) => {
  const { h } = island.dom;

  return island.definePlugin({
    id: "cpu-alarm",
    label: "CPU alarm",
    description: "Turns the pill red while the processor stays busy.",
    // Inner SVG markup for a 16×16 stroke icon.
    icon: `<path d="M8 2v7"/><circle cx="8" cy="12.5" r="1"/>`,
    slots: ["glance", "tab"],
    // Only the services listed here are handed to `setup`.
    needs: ["stats"],
    options: {
      limit: island.options.number("Alarm above", 85, { min: 10, max: 100, step: 5, unit: "%" }),
    },

    /** @param {{ stats: { stats(): Promise<{ cpu: number } | null> } }} services */
    setup({ stats }, host) {
      /** @type {number | null} */
      let cpu = null;
      const value = h("span", { class: "value" }, "–");

      return {
        panel: (root) => root.append(h("div", { class: "stat" }, h("span", { class: "eyebrow" }, "CPU"), value)),
        // Runs once a second while the plugin is placed.
        async tick() {
          const sample = await stats.stats();
          cpu = sample ? sample.cpu : null;
          value.textContent = cpu === null ? "–" : `${Math.round(cpu)}%`;
        },
        // Something to say on the pill, or null to let the next plugin speak.
        glance: () => (cpu !== null && cpu > host.options().limit ? { text: `CPU ${Math.round(cpu)}%`, tone: "alert" } : null),
      };
    },
  });
};
