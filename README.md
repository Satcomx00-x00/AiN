# Orbit clock: an AiN plugin template

A starting point for [AiN](https://github.com/Satcomx00-x00/AiN) community plugins. It is a working
plugin: an analog and/or digital clock in its tab, the time with a ring on the pill, and other time
zones.

It shows how a plugin can:

- **Take settings.** Its options (tab face, 12/24-hour, seconds, what the pill says, the ring,
  the hand color, a flash on the hour, time zones) are drawn in **Settings → Plugins**, right under
  its switch, and in **Settings → Widgets**. A `settingsPanel` adds a live check of the time zones.
- **Follow the theme.** It uses the island's colors (`--fg`, `--muted`, `--accent`, `--ok`,
  `--hot`…), and draws the dial differently on a light or a dark pill.
- **Fit the pill style and size.** Through `host.appearance()`: Stub and Sliver show no text, so
  it gives them a ring even when the ring is off; at the Low profile size the pill gets the time
  alone. On versions of AiN without `host.appearance()`, it keeps its plain look.

A plugin is a single [`index.js`](index.js), with no build step and no dependencies.

## Try it

1. In AiN, **Settings → Plugins → Open plugins folder**.
2. Make an `orbit-clock` folder there and copy `index.js` into it.
3. Click **Refresh**, then turn **Orbit clock** on. Move it in **Settings → Layout**.

It is also in the community store: **Settings → Plugins → Community store → Install**.

## Make your own

1. Create a repository from this branch (or copy `index.js`).
2. Change the `id` (2–32 lowercase letters, digits or dashes, not one AiN already uses), `label`,
   `description` and `icon`, then the `setup` that does the work. The
   [plugin guide](https://github.com/Satcomx00-x00/AiN/blob/main/docs/plugins.md) lists every
   part of the API: services (`stats`, `media`, `volume`, `privacy`), options, glances, settings
   panels, `host.appearance()`.
3. After changing the file, restart AiN to load the new version.
4. To list it in the store, open a pull request against the
   [`store`](https://github.com/Satcomx00-x00/AiN/tree/store) branch adding it to `store.yaml`.

## License

MIT, see [LICENSE](LICENSE).
