# Writing a plugin

A plugin adds a widget to the island: something on the pill, a tab, or both. It is a single
JavaScript file: no build step, no dependencies.

> [!WARNING]
> A plugin runs inside the island with the island's permissions, like an app you install. Only
> turn on plugins you trust.

## Install one

1. **Settings → Plugins → Open plugins folder.**
2. Put the plugin there: a `.js` file, or a folder with an `index.js`.
3. Back in **Settings → Plugins**, click **Refresh**, then turn the plugin on. It is placed in the
   tabs (or on the pill) right away; move it in **Settings → Layout**.

After changing a plugin's file, restart Island.

## The shape of a plugin

The file default-exports a function. The island calls it with its SDK, and it returns the
plugin's definition:

```js
export default (island) =>
  island.definePlugin({
    id: "cpu-alarm",              // 2–32 lowercase letters, digits or dashes
    label: "CPU alarm",           // shown in Settings and as the tab's tooltip
    description: "Turns the pill red while the processor stays busy.",
    icon: `<path d="M8 2v7"/>`,   // inner SVG of a 16×16 stroke icon
    slots: ["glance", "tab"],     // where it can go: the pill, a tab, or both
    needs: ["stats"],             // the services `setup` receives
    options: {                    // drawn in Settings → Widgets
      limit: island.options.number("Alarm above", 85, { min: 10, max: 100, step: 5, unit: "%" }),
    },
    setup({ stats }, host) {
      return {
        panel(root) {},           // builds its tab, once
        async tick({ now, visible }) {}, // every second
        glance(now) { return null; },    // what to say on the pill, or null
        ambient() { return null; },      // a color to tint the island, or null
      };
    },
  });
```

[`examples/plugins/cpu-alarm.js`](../widget-island/examples/plugins/cpu-alarm.js) is a complete,
working plugin.

### What `setup` receives

- **services**: only those named in `needs`:

  | Service | Methods |
  | --- | --- |
  | `stats` | `stats()` → `{ cpu, memUsed, memTotal, rxPerSec, txPerSec, sampledAt }` or `null` |
  | `media` | `watch(onTrack)`, `artwork()`, `control("toggle" \| "next" \| "previous")` |
  | `volume` | `watch(onOutput)`, `watchSources(onSources)`, `peak()`, `setLevel(level, source?)`, `setMuted(muted, source?)` |
  | `privacy` | `watch(onUsage)` with `{ mic: string[], camera: string[] }` |

  `watch` methods call back with the current value right away, then on every change; they
  resolve with a function that stops watching. Clipboard history, screen captures and dictation
  are not available to plugins.

- **host**: `host.options()` reads the plugin's options (read them when needed, the user can
  change them anytime), `host.setOptions(patch)` saves some, `host.refresh()` redraws the
  pill now instead of at the next second, and `host.openSettings()` opens Settings at the
  plugin's card.

### What it returns

Every part is optional. A **glance** is `{ text }` plus, optionally, `progress` (0–1, a ring),
`level` (0–1, a bar), `spark` (recent values 0–100), `art` (an image URL), `mark`
(`"mic"`, `"camera"`, `"eq"` or `"rec"`), `tone` (`"alert"` or `"muted"`) and `wide` (widen the pill
while shown). Several plugins can share a spot on the pill: the first one with something to say wins.

If a part throws, the island turns that part off and logs why (in the island's developer tools),
rather than letting it break the island.

### Setting up in Settings, not in the island

Options cover most settings. For setup they can't express (signing in, downloading something),
add `settingsPanel(root, services)`: it draws extra controls under the options of the plugin's
card in **Settings → Widgets**, with the same services as `setup`. Return a function that stops
whatever it watches; Settings calls it when the card is redrawn or the window closes. Its third
argument, `host`, reads and saves the plugin's options; mark an option `inPanel: true` to draw it
yourself there (e.g. a choice showing live state), in place of the standard control. The classes
`field`, `field-label`, `field-hint`, `secondary` (buttons) and `progress` (a bar: set `--p`
from 0 to 1) match the rest of the page. From the island, `host.openSettings()` brings the user
there.

## A startup animation

A file can define the animation the pill plays when the island starts instead of a plugin: its
definition has `play` and no `setup`. Once the file is on, the animation can be picked in
**Settings → Appearance**; picking it plays it once, and the Play button next to it plays it again.

```js
export default (island) =>
  island.defineGreeting({
    id: "wave",
    label: "Wave",
    async play({ island: pill, surface, glance, size }) {
      // Animate `pill`, add elements to `surface`, hide `glance` until the end…
      await island.settle([pill.animate(/* keyframes */, { duration: 1500, fill: "backwards" })]);
    },
  });
```

- `play` gets the pill (`island`), its clipped inside (`surface`), the usual glances (`glance`, may
  be `null`), the pill's resting `size` in px (the chosen style's, at the chosen pill size) and
  `scale`, the pill size's scale (1 for Normal): multiply fixed sizes by it, or use `--scale` in
  CSS. Resolve once done; remove what you added.
- Use `fill: "backwards"` on the pill, so its own style takes over once you're done.
- It is given 6 seconds at most; if it throws, the island goes on without it. It isn't played for
  people who ask for reduced motion.
- Its id can't be one a built-in animation (`hello`, `boing`, `sparkle`, `typewriter`), a
  feature or another plugin uses.

See [`examples/plugins/wave.js`](../widget-island/examples/plugins/wave.js).

## A pill style

A file can also define how the folded island looks: its definition has `mount` and no `setup`.
Once the file is on, the style can be picked in **Settings → Appearance → Pill style**, next to
the built-in ones (Pill, Solo, Stub, Sliver and Hidden). A style only draws the folded island: hovering still opens
it, and the startup animation, the pill size (low profile, normal, large) and the colors still
apply.

```js
export default (island) =>
  island.defineStyle({
    id: "neon-line",
    label: "Neon line",
    options: { thickness: island.options.number("Thickness", 4, { min: 2, max: 12, unit: "px" }) },
    size: (pill, { thickness }) => ({ width: pill.width, height: thickness * pill.scale }),
    mount(root, { options }) {
      const line = island.dom.h("div");
      root.append(line);
      return {
        draw({ left, right, ambient, alert }) {
          /* update `line` from what the glances say */
        },
      };
    },
  });
```

- `mount(root, { options })` builds the look inside `root`, the pill's glance row, once each time
  the style is picked. It returns a view: `draw` runs every second and whenever a glance changes,
  and `destroy`, if given, when another style is picked. `root` is emptied for you.
- `draw` gets what the two glance spots say (`left`, `right`, each a glance or `null`, and
  `leftFrom` / `rightFrom`, the plugin speaking), the tint of what is in focus (`ambient`),
  `alert` and `wide` (a live activity). `island.ui.glanceSlot()` draws a glance as the Pill does.
- `size(pill, options)`, if given, sets the folded size from the pill's: `pill.width`,
  `pill.height`, `pill.hasNotch` and `pill.scale`. It is kept between 8×2 and 960×120 px.
- `hidden: true` keeps the pill out of sight until the cursor rests at the top center of the screen,
  as the Hidden style does.
- `widens: false` keeps a live activity (music…) from widening it, for a style without text.
- `description` is one line under its name in Settings.
- Open, the island is never shorter than the pill, so the panel looks the same under every style.
- `options` are drawn under the style in Settings, like a plugin's; read them with `options()`.
- Use the island's colors (`var(--fg)`, `var(--accent)`, `var(--ambient)`, `var(--done)`…) and
  `--scale` for sizes, so the style follows the theme and the pill size.
- If `mount` or `draw` throws, the island sets the style aside and shows the Pill.

See [`examples/plugins/neon-line.js`](../widget-island/examples/plugins/neon-line.js).

## The SDK

| | |
| --- | --- |
| `island.definePlugin(def)` | returns `def`; for editors that understand JSDoc types |
| `island.defineGreeting(def)` | the same, for a startup animation |
| `island.defineStyle(def)` | the same, for a pill style |
| `island.settle(animations)` | resolves once every Web Animation given has finished or been cancelled |
| `island.options` | `toggle`, `number`, `choice`, `list`, `folder`, `text`: option fields for Settings |
| `island.dom` | `h(tag, attrs, ...children)`, `button`, `icon`, `svg`, `tween`, `odometer`, `roll`, `reducedMotion` |
| `island.chart` | `curve`, `curveArea`, `sparkline`: SVG paths for small graphs |
| `island.color` | `isLight`, `pickColor`, `imageColor` and other color helpers |
| `island.ui.select(options, value, onChange, label)` | a drop-down list styled like the island: each option has a `label`, and optionally a `detail` line, a `meta` fact on the right and a `badge`. Returns `{ el, set, setOptions }` |
| `island.ui.glanceSlot()` | a glance spot drawn as on the Pill, for styles: `{ el, draw(glance, from) }` |
| `island.version` | `1`; it changes when the SDK changes in a way that could break plugins |

## What a plugin can't do

- Use an id a built-in feature, startup animation or pill style uses (`clock`, `media`, `hello`,
  `pill`, `stub`, …), or one another plugin already took.
- Define keyboard shortcuts: those are for built-in features.
- Ask for services other than those above.

Why a plugin was refused shows in **Settings → Plugins**.
