# Orbit clock: an AiN plugin template

A starting point for [AiN](https://github.com/Satcomx00-x00/AiN) community plugins. It is a working
plugin: an analog clock in its tab, the time with a seconds ring on the pill, and other time zones
you pick in **Settings → Widgets**.

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
   part of the API: services (`stats`, `media`, `volume`, `privacy`), options, glances, settings panels.
3. After changing the file, restart AiN to load the new version.
4. To list it in the store, open a pull request against the
   [`store`](https://github.com/Satcomx00-x00/AiN/tree/store) branch adding it to `store.yaml`.

## License

MIT, see [LICENSE](LICENSE).
