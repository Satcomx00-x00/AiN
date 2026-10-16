// Orbit clock: a template for AiN community plugins.
//
// The pill shows the time with a ring that fills as the minute goes by; the tab shows an analog
// dial next to the time, the date and the other time zones you pick in Settings → Widgets.
//
// A plugin is an ES module whose default export receives the island's SDK and returns a plugin
// definition. It runs as-is: no build step, no imports. See
// https://github.com/Satcomx00-x00/AiN/blob/main/docs/plugins.md for the whole API.

/** @param {any} island AiN's SDK: see "The SDK" in docs/plugins.md */
export default (island) => {
  const { h, svg } = island.dom;

  /** Hours and minutes, following the system's 12/24-hour format, optionally in another zone. */
  const hm = (timeZone) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone });
  const day = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
  const local = hm(undefined);

  /** A zone's formatter, or null when the name isn't a time zone the system knows. */
  const zones = new Map();
  const zone = (name) => {
    if (!zones.has(name)) {
      try {
        zones.set(name, hm(name));
      } catch {
        zones.set(name, null);
      }
    }
    return zones.get(name);
  };

  // The dial: 12 ticks, three hands; each hand is rotated around the center (50, 50).
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const long = i % 3 === 0;
    return `<line x1="50" y1="${long ? 8 : 10}" x2="50" y2="${long ? 16 : 14}" transform="rotate(${i * 30} 50 50)" stroke-width="${long ? 3 : 2}"/>`;
  }).join("");
  const DIAL = `
    <circle cx="50" cy="50" r="46" class="orbit-face"/>
    <g class="orbit-ticks">${ticks}</g>
    <line data-hand="hour" x1="50" y1="50" x2="50" y2="28" stroke-width="5"/>
    <line data-hand="minute" x1="50" y1="50" x2="50" y2="16" stroke-width="3.5"/>
    <line data-hand="second" x1="50" y1="58" x2="50" y2="12" stroke-width="1.5"/>
    <circle cx="50" cy="50" r="3.5" class="orbit-pin"/>`;

  // Plugins bring their own styles; the island's colors (--fg, --muted, --accent…) follow the theme.
  const CSS = `
    .orbit { display: flex; align-items: center; gap: 18px; height: 100%; }
    .orbit-dial { width: 96px; height: 96px; flex: none; }
    .orbit-face { fill: color-mix(in srgb, var(--fg) 6%, transparent); stroke: color-mix(in srgb, var(--fg) 14%, transparent); stroke-width: 1.5; }
    .orbit-ticks line { stroke: var(--muted); stroke-linecap: round; }
    .orbit-dial [data-hand] { stroke: var(--fg); stroke-linecap: round; }
    .orbit-dial [data-hand="second"], .orbit-pin { stroke: var(--accent); fill: var(--accent); }
    .orbit-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .orbit-time { font-size: 30px; font-weight: 650; letter-spacing: -0.03em; line-height: 1; }
    .orbit-date { font-size: 13px; text-transform: capitalize; }
    .orbit-zones { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--muted); }
    .orbit-zones b { color: var(--fg); font-weight: 600; }`;

  return island.definePlugin({
    // Must be unique among the island's features and plugins: 2–32 lowercase letters, digits or dashes.
    id: "orbit-clock",
    label: "Orbit clock",
    description: "An analog clock, a seconds ring on the pill and other time zones.",
    // Inner markup of a 16×16 stroke icon.
    icon: `<circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.5 1.5"/><circle cx="8" cy="1.75" r=".9" fill="currentColor"/>`,
    slots: ["glance", "tab"],
    // Drawn in Settings → Widgets; read with host.options().
    options: {
      ring: island.options.toggle("Seconds ring on the pill", true),
      zones: island.options.list("Other time zones", ["UTC"], "e.g. America/New_York", "IANA names, shown in the tab."),
    },

    setup(_services, host) {
      const dial = svg("0 0 100 100", DIAL, "orbit-dial");
      const hands = Object.fromEntries([...dial.querySelectorAll("[data-hand]")].map((el) => [el.dataset.hand, el]));
      const time = h("div", { class: "orbit-time" });
      const date = h("div", { class: "orbit-date" });
      const others = h("div", { class: "orbit-zones" });

      return {
        // Builds the tab, once.
        panel(root) {
          root.append(h("style", {}, CSS), h("div", { class: "orbit" }, dial, h("div", { class: "orbit-text" }, time, date, others)));
        },

        // Runs every second while the plugin is placed; `visible` is true while its tab is shown.
        tick({ now, visible }) {
          if (!visible) return;
          const d = new Date(now);
          const s = d.getSeconds();
          const m = d.getMinutes() + s / 60;
          const hr = (d.getHours() % 12) + m / 60;
          hands.hour.setAttribute("transform", `rotate(${hr * 30} 50 50)`);
          hands.minute.setAttribute("transform", `rotate(${m * 6} 50 50)`);
          hands.second.setAttribute("transform", `rotate(${s * 6} 50 50)`);
          time.textContent = local.format(d);
          date.textContent = day.format(d);
          others.replaceChildren(
            ...host.options().zones.map((name) => {
              const f = zone(name);
              const city = name.split("/").pop().replace(/_/g, " ");
              return h("span", {}, `${city} `, h("b", {}, f ? f.format(d) : "?"));
            }),
          );
        },

        // What the pill says: the time, and a ring that fills over the minute.
        glance(now) {
          const d = new Date(now);
          return { text: local.format(d), ...(host.options().ring ? { progress: d.getSeconds() / 60 } : {}) };
        },
      };
    },
  });
};
