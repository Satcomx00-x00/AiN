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
whatever it watches; Settings calls it when the card is redrawn or the window closes. The classes
`field`, `field-label`, `field-hint`, `secondary` (buttons) and `progress` (a bar: set `--p`
from 0 to 1) match the rest of the page. From the island, `host.openSettings()` brings the user
there.

## The SDK

| | |
| --- | --- |
| `island.definePlugin(def)` | returns `def`; for editors that understand JSDoc types |
| `island.options` | `toggle`, `number`, `choice`, `list`, `folder`: option fields for Settings |
| `island.dom` | `h(tag, attrs, ...children)`, `button`, `icon`, `svg`, `tween`, `odometer`, `roll`, `reducedMotion` |
| `island.chart` | `curve`, `curveArea`, `sparkline`: SVG paths for small graphs |
| `island.color` | `isLight`, `pickColor`, `imageColor` and other color helpers |
| `island.version` | `1`; it changes when the SDK changes in a way that could break plugins |

## What a plugin can't do

- Use an id a built-in feature uses (`clock`, `media`, …), or one another plugin already took.
- Define keyboard shortcuts: those are for built-in features.
- Ask for services other than those above.

Why a plugin was refused shows in **Settings → Plugins**.
