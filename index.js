// Orbit clock: a template for AiN community plugins.
//
// The pill shows the time with a ring that fills over the minute or the hour; the tab shows an
// analog dial and/or a digital clock, the date and the other time zones you pick. Everything is set
// in Settings → Plugins, under the plugin's switch (and in Settings → Widgets).
//
// It follows how the island looks: the theme's colors, a light or dark pill, the pill style (Stub
// and Sliver show no text, so it gives them a ring) and the pill size (Low profile gets the time
// alone).
//
// A plugin is an ES module whose default export receives the island's SDK and returns a plugin
// definition. It runs as-is: no build step, no imports. See
// https://github.com/Satcomx00-x00/AiN/blob/main/docs/plugins.md for the whole API.

/** @param {any} island AiN's SDK: see "The SDK" in docs/plugins.md */
export default (island) => {
  const { h, svg } = island.dom;

  /** Pill styles that draw marks and progress but no text. */
  const TEXTLESS = new Set(["stub", "sliver"]);
  /** How long the pill asks for attention at the top of the hour, in seconds. */
  const CHIME_SECONDS = 10;
  /** What `host.appearance()` says on versions of AiN before it existed. */
  const PLAIN = { style: "pill", size: "normal", theme: "island", tone: "dark", notch: false };

  /** Hands colored after one of the theme's colors, so they follow the theme the user picked. */
  const HAND_COLORS = { accent: "var(--accent)", ok: "var(--ok)", done: "var(--done)", hot: "var(--hot)" };

  // Formatters are slow to build: one per format, reused.
  const formats = new Map();
  /** A formatter, or null when `timeZone` isn't one the system knows. */
  const format = (key, options) => {
    if (!formats.has(key)) {
      try {
        formats.set(key, new Intl.DateTimeFormat(undefined, options));
      } catch {
        formats.set(key, null);
      }
    }
    return formats.get(key);
  };
  /** The time as the options ask: 12- or 24-hour or the system's way, with or without seconds. */
  const clock = (o, timeZone) =>
    format(`time|${o.hours}|${o.seconds}|${timeZone ?? ""}`, {
      hour: "2-digit",
      minute: "2-digit",
      ...(o.seconds && { second: "2-digit" }),
      ...(o.hours === "12" && { hour12: true }),
      ...(o.hours === "24" && { hourCycle: "h23" }),
      timeZone,
    });
  const weekday = format("weekday", { weekday: "short" });
  const date = format("date", { weekday: "long", day: "numeric", month: "long" });
  /** "Tokyo" for "Asia/Tokyo". */
  const city = (zone) => zone.split("/").pop().replace(/_/g, " ");

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

  // Plugins bring their own styles. The island's colors (--fg, --muted, --accent, --ok, --hot…)
  // follow the theme; the data attributes set in `tick` cover the rest.
  const CSS = `
    .orbit { --hand: var(--accent); display: flex; align-items: center; gap: 18px; height: 100%; }
    .orbit-dial { width: 96px; height: 96px; flex: none; }
    .orbit[data-face="digital"] .orbit-dial, .orbit[data-face="analog"] .orbit-time { display: none; }
    .orbit-face { fill: color-mix(in srgb, var(--fg) 6%, transparent); stroke: color-mix(in srgb, var(--fg) 14%, transparent); stroke-width: 1.5; }
    /* On a light pill, a faint fill disappears: draw the face's edge stronger instead. */
    .orbit[data-tone="light"] .orbit-face { fill: none; stroke: color-mix(in srgb, var(--fg) 28%, transparent); }
    /* On a dark one, the hand that counts seconds glows a little. */
    .orbit[data-tone="dark"] [data-hand="second"] { filter: drop-shadow(0 0 2px var(--hand)); }
    .orbit-ticks line { stroke: var(--muted); stroke-linecap: round; }
    .orbit-dial [data-hand] { stroke: var(--fg); stroke-linecap: round; }
    .orbit-dial [data-hand="second"], .orbit-pin { stroke: var(--hand); fill: var(--hand); }
    .orbit[data-seconds="false"] [data-hand="second"] { display: none; }
    .orbit[data-chime="true"] .orbit-face { stroke: var(--hand); }
    .orbit-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .orbit-time { font-size: 30px; font-weight: 650; letter-spacing: -0.03em; line-height: 1; font-variant-numeric: tabular-nums; }
    .orbit[data-face="digital"] .orbit-time { font-size: 40px; }
    .orbit-date { font-size: 13px; text-transform: capitalize; }
    .orbit-zones { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--muted); }
    .orbit-zones b { color: var(--fg); font-weight: 600; }
    .orbit-zones .unknown b { color: var(--hot); }`;

  return island.definePlugin({
    // Must be unique among the island's features and plugins: 2–32 lowercase letters, digits or dashes.
    id: "orbit-clock",
    label: "Orbit clock",
    description: "An analog or digital clock, a ring on the pill and other time zones.",
    // Inner markup of a 16×16 stroke icon.
    icon: `<circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.5 1.5"/><circle cx="8" cy="1.75" r=".9" fill="currentColor"/>`,
    slots: ["glance", "tab"],
    // Drawn in Settings, under the plugin's switch; read them with host.options(). Up to three
    // choices show as buttons, more as a drop-down list.
    options: {
      face: island.options.choice("Tab face", "both", [
        ["analog", "Analog"],
        ["digital", "Digital"],
        ["both", "Both"],
      ]),
      hours: island.options.choice("Hours", "system", [
        ["system", "System"],
        ["12", "12-hour"],
        ["24", "24-hour"],
      ]),
      seconds: island.options.toggle("Seconds", false, "In the time, and as a hand on the dial."),
      pill: island.options.choice(
        "On the pill",
        "time",
        [
          ["time", "Time"],
          ["day", "Day and time"],
          ["zone", "First time zone"],
        ],
        "The Low profile size shows the time alone.",
      ),
      ring: island.options.choice(
        "Ring on the pill",
        "minute",
        [
          ["minute", "Minute"],
          ["hour", "Hour"],
          ["off", "Off"],
        ],
        "Stub and Sliver show only this ring: there it stays on.",
      ),
      hand: island.options.choice("Hand color", "accent", [
        ["accent", "Accent"],
        ["ok", "Green"],
        ["done", "Orange"],
        ["hot", "Red"],
      ]),
      chime: island.options.toggle("Flash on the hour", false, `The pill asks for attention for ${CHIME_SECONDS} seconds.`),
      zones: island.options.list("Other time zones", ["UTC"], "e.g. America/New_York", "IANA names, shown in the tab."),
    },

    // Extra controls in the plugin's Settings card, under its options: here, the zones as entered,
    // checked live. Returns what stops it when the card is redrawn or closed.
    settingsPanel(root, _services, host) {
      const line = h("p", { class: "field-hint" });
      root.append(line);
      const draw = () => {
        const o = host.options();
        const now = new Date();
        line.textContent = o.zones.length
          ? o.zones.map((zone) => `${city(zone)} ${clock(o, zone)?.format(now) ?? "(unknown time zone)"}`).join(" · ")
          : "No other time zones.";
      };
      draw();
      const timer = setInterval(draw, 1000);
      return () => clearInterval(timer);
    },

    setup(_services, host) {
      /** How the island looks: its pill style, size, theme and tone. */
      const look = () => host.appearance?.() ?? PLAIN;

      const dial = svg("0 0 100 100", DIAL, "orbit-dial");
      const hands = Object.fromEntries([...dial.querySelectorAll("[data-hand]")].map((el) => [el.dataset.hand, el]));
      const time = h("div", { class: "orbit-time" });
      const day = h("div", { class: "orbit-date" });
      const others = h("div", { class: "orbit-zones" });
      const orbit = h("div", { class: "orbit" }, dial, h("div", { class: "orbit-text" }, time, day, others));

      /** True during the first seconds of each hour, when the user asked for a flash. */
      const chiming = (o, d) => o.chime && d.getMinutes() === 0 && d.getSeconds() < CHIME_SECONDS;

      /** How far the ring has filled, 0–1, or undefined for no ring. */
      const ringOf = (ring, d) => {
        if (ring === "hour") return (d.getMinutes() * 60 + d.getSeconds()) / 3600;
        if (ring === "minute") return d.getSeconds() / 60;
        return undefined;
      };

      /** The pill's text, after the option and the room the pill size leaves. */
      const pillText = (o, d, size) => {
        const local = clock({ ...o, seconds: false }).format(d);
        if (size === "low") return local;
        if (o.pill === "day") return `${weekday.format(d)} ${local}`;
        const zone = o.pill === "zone" && o.zones[0];
        const there = zone && clock({ ...o, seconds: false }, zone);
        return there ? `${city(zone)} ${there.format(d)}` : local;
      };

      return {
        // Builds the tab, once.
        panel(root) {
          root.append(h("style", {}, CSS), orbit);
        },

        // Runs every second while the plugin is placed; `visible` is true while its tab is shown.
        tick({ now, visible }) {
          if (!visible) return;
          const o = host.options();
          const d = new Date(now);
          // CSS reacts to these: the options read here and how the island looks right now.
          Object.assign(orbit.dataset, { face: o.face, seconds: String(o.seconds), tone: look().tone, chime: String(chiming(o, d)) });
          orbit.style.setProperty("--hand", HAND_COLORS[o.hand] ?? HAND_COLORS.accent);

          const s = d.getSeconds();
          const m = d.getMinutes() + s / 60;
          const hr = (d.getHours() % 12) + m / 60;
          hands.hour.setAttribute("transform", `rotate(${hr * 30} 50 50)`);
          hands.minute.setAttribute("transform", `rotate(${m * 6} 50 50)`);
          hands.second.setAttribute("transform", `rotate(${s * 6} 50 50)`);
          time.textContent = clock(o).format(d);
          day.textContent = date.format(d);
          others.replaceChildren(
            ...o.zones.map((zone) => {
              const f = clock({ ...o, seconds: false }, zone);
              return h("span", f ? {} : { class: "unknown", title: "Not a time zone this system knows" }, `${city(zone)} `, h("b", {}, f ? f.format(d) : "?"));
            }),
          );
        },

        // What the pill says, read every second and whenever the settings change.
        glance(now) {
          const o = host.options();
          const { style, size } = look();
          const d = new Date(now);
          // Stub and Sliver draw no text, only a ring or a strip: give them one even when it's off.
          const progress = ringOf(TEXTLESS.has(style) && o.ring === "off" ? "minute" : o.ring, d);
          return {
            text: pillText(o, d, size),
            ...(progress !== undefined && { progress }),
            ...(chiming(o, d) && { tone: "alert" }),
          };
        },
      };
    },
  });
};
