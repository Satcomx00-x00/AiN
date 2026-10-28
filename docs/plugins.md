# Writing a plugin

A plugin adds a widget to the island: something on the pill, a tab, or both. It is a single
JavaScript file: no build step, no dependencies.

> [!WARNING]
> A plugin runs inside the island with the island's permissions, like an app you install. Only
> turn on plugins you trust.

## Install one

From the community store: **Settings → Plugins → Community store**, then **Install**. The plugin's
file is downloaded from its repository into the plugins folder, off: read it (**Repository** opens
it), then turn it on above. **Update** downloads the latest version again; restart AiN to load it.

By hand:

1. **Settings → Plugins → Plugins folder → Open.**
2. Put the plugin there: a `.js` file, or a folder with an `index.js`.
3. Back in **Settings → Plugins**, click **Refresh**, then turn the plugin on. It is placed in the
   tabs (or on the pill) right away; move it in **Settings → Pill**.

After changing a plugin's file, restart AiN.

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
    panelHeight: 156,             // optional: how tall the open panel is on its tab (156–340 px)
    options: {                    // drawn in Settings, under the plugin's switch
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

[`examples/plugins/cpu-alarm.js`](../ain/examples/plugins/cpu-alarm.js) is a complete,
working plugin.

A tab gets the open panel's usual 156 px. One that needs room, like a calendar's week or month,
sets `panelHeight`: the island grows to it while that tab is shown and back when another is, up to
340 px.

### What `setup` receives

- **services**: only those named in `needs`:

  | Service | Methods |
  | --- | --- |
  | `stats` | `stats()` → `{ cpu, memUsed, memTotal, rxPerSec, txPerSec, sampledAt }` or `null` |
  | `media` | `watch(onTrack)`, `artwork()`, `control("toggle" \| "next" \| "previous")` |
  | `volume` | `watch(onOutput)`, `watchSources(onSources)`, `peak()`, `setLevel(level, source?)`, `setMuted(muted, source?)` |
  | `privacy` | `watch(onUsage)` with `{ mic: string[], camera: string[] }` |
  | `oauth` | `signIn(provider)`, `token(provider)`, `signOut(provider)`, `signedIn(provider)`: see [Signing in to an online account](#signing-in-to-an-online-account) |
  | `notifications` | `list()`, `watch(onHistory)`, `markSeen()`, `remove(id)`, `clear()`, `act(id, actionId)`: the history; also lets `onNotification` see every notification (see [Notifications](#notifications)) |
  | `ai` | `ask(text, { instructions })` → the answer: see [Asking AI](#asking-ai) |

  `watch` methods call back with the current value right away, then on every change; they
  resolve with a function that stops watching. Clipboard history, screen captures, dictation,
  read aloud and conversation are not available to plugins.

- **host**: `host.options()` reads the plugin's options (read them when needed, the user can
  change them anytime), `host.setOptions(patch)` saves some, `host.secret(key)` reads one of its
  secrets (see below), `host.refresh()` redraws the pill now instead of at the next second,
  `host.openSettings()` opens Settings at the plugin's card, `host.openPage(params)` opens its
  page (see below), `host.appearance()` tells how the island looks (see below),
  `host.notify(notice)` posts a notification (see [Notifications](#notifications)) and
  `host.on(event, listener)` follows what happens on the island (see [Events](#events)).

### Options the user sets

`options` lists what the user can set; Settings draws a control for each under the plugin's
switch, and `host.options()` hands the plugin their values (or the defaults). Each builder takes
the label first:

| Builder | Control | Value |
| --- | --- | --- |
| `toggle(label, value, hint?)` | a switch | `true` or `false` |
| `number(label, value, { min, max, step?, unit?, box? }, hint?)` | a slider; with `box: true`, a box to type in, for wide ranges like a port | a number in range |
| `choice(label, value, [[value, label], …], hint?)` | buttons side by side, or a drop-down list past three | one of the values |
| `list(label, value, placeholder?, hint?)` | chips, added with Enter | an array of strings |
| `folder(label, placeholder?, hint?)` | a path and a Browse… button | a path, `""` for the default |
| `text(label, value, { placeholder?, hint?, multiline?, required?, pattern?, invalid?, maxLength? })` | a text field, or several lines with `multiline` | a string |
| `secret(label, { placeholder?, hint?, required?, pattern?, invalid? })` | a hidden field | read it with `host.secret(key)` |
| `color(label, "#rrggbb", hint?)` | a color picker | `"#rrggbb"` |

`text(label, value, placeholder?, hint?)` still works as before.

**Checking what's typed.** A text or secret can be `required`, match a `pattern` (a regular
expression the whole value must match, e.g. `"[a-f0-9]{32}"`), and be at most `maxLength`
characters. Settings says what's wrong under the field (`invalid` words it: `"32 hex digits"` gives
"Expected 32 hex digits.") and doesn't save the value until it fits; a number in a `box` must be in
range and on a step. While a required option is empty, the plugin's card says **Needs setup**, so
check for it in the plugin too and say what's missing (e.g. a glance pointing to
`host.openSettings()`). A value that doesn't fit (written to the settings file by hand) reaches the
plugin as the default.

**Secrets.** API keys, tokens and passwords belong in a `secret`: typed hidden, it is kept in the
system's credential store (Windows Credential Manager, the macOS Keychain, the Secret Service on
Linux) rather than in the settings file, and Settings only shows whether one is saved. Its key is
letters, digits, `_` or `-`. Read it when needed, it can change anytime:

```js
options: {
  apiKey: island.options.secret("API key", { required: true, pattern: "[a-f0-9]{32}", invalid: "32 hex digits" }),
  city: island.options.text("City", "", { required: true, placeholder: "e.g. Lyon" }),
},
setup(services, host) {
  return {
    async tick() {
      const key = await host.secret("apiKey"); // "" when none is saved
      if (!key) return;
      // fetch the forecast for host.options().city …
    },
  };
},
```

`host.secret` gives a plugin only the secrets it declares. That keeps them off disk in plain text,
not away from other plugins: every plugin runs with the island's permissions. Older versions of AiN
don't have it; `host.secret?.(key)` lets a plugin say it needs a newer one there. Secrets stay in
the credential store when the plugin is turned off; **Remove** deletes one. **Reset to defaults**,
under the options, puts every other option back.

### What it returns

Every part is optional. A **glance** is `{ text }` plus, optionally, `progress` (0–1, a ring),
`level` (0–1, a bar), `spark` (recent values 0–100), `art` (an image URL), `icon` (inner SVG of a
16×16 stroke icon), `mark` (`"mic"`, `"camera"`, `"eq"` or `"rec"`), `tone` (`"alert"` or `"muted"`)
and `wide` (widen the pill while shown). Several plugins can share a spot on the pill: the first ones
with something to say show, as many side by side as the user picked in **Settings → Pill**. There the
user can also add the plugin's icon to its glance, or keep its icon on the pill while it has nothing
to say.

Give the plugin a `sample(options)` returning a glance with made-up data, and the preview in
**Settings → Pill** shows what it looks like; otherwise the preview shows its label. Mark an option
`pill: true` (e.g. `{ ...choice("On the pill", "time", […]), pill: true }`) when it only matters on
the pill: **Settings → Pill** offers it while the plugin is placed there.

### Following the island's look

The island's colors are CSS variables on every plugin's tab: `--bg`, `--fg`, `--muted`,
`--accent`, `--on-accent`, `--ok`, `--warn`, `--hot` and `--done`. Use them rather than fixed
colors, and the plugin follows the theme and the user's pill and accent colors.

For the rest, `host.appearance()` returns `{ style, size, theme, tone, notch }`:

- `style`: the pill style drawing the folded island (`"pill"`, `"solo"`, `"stub"`, `"sliver"`,
  `"hidden"` or a plugin's). Stub and Sliver show no text, only a ring, a bar or a mark, so give
  them a `progress` or a `mark` to show anything at all.
- `size`: `"low"`, `"normal"` or `"large"`; there is less room for text at Low profile.
- `theme`: the theme's id, e.g. `"dracula"`.
- `tone`: `"light"` or `"dark"`, after the pill color: a faint tint that shows on a dark pill
  vanishes on a light one.
- `notch`: true when a hardware notch sets the pill's height.

Read it when drawing, in `glance` and `tick`: the user can change it anytime. Older versions of
AiN don't have it; `host.appearance?.()` lets a plugin fall back to its plain look there. The
[plugin template](https://github.com/Satcomx00-x00/AiN/tree/plugin-template) uses all of it.

If a part throws, the island turns that part off and logs why (in the island's developer tools),
rather than letting it break the island.

### Setting up in Settings, not in the island

Options cover most settings. For setup they can't express (signing in, downloading something),
add `settingsPanel(root, services)`: it draws extra controls under the options of the plugin's
card, in **Settings → Plugins** under its switch and in **Settings → Widgets**, with the same services as `setup`. Return a function that stops
whatever it watches; Settings calls it when the card is redrawn or the window closes. Its third
argument, `host`, reads and saves the plugin's options; mark an option `inPanel: true` to draw it
yourself there (e.g. a choice showing live state), in place of the standard control. The classes
`field`, `field-label`, `field-hint`, `secondary` (buttons) and `progress` (a bar: set `--p`
from 0 to 1) match the rest of the page. From the island, `host.openSettings()` brings the user
there.

### A page of its own

The island takes no typing, and a card is small. For work that needs both, like editing a record,
a plugin adds `page(root, services, host)`: it gets the whole Settings window (no menu, no
margins; the window grows to about 1200 × 800 when a page opens), so it draws everything,
including a way back that calls `host.close()`. `host.setTitle(text)` names the window. It gets the
same services as `setup`, and returns a function that stops whatever it watches, called when the
page is left.

```js
page(root, { oauth }, host) {
  host.setTitle(host.params.event ? "Edit event" : "New event");
  // … draw a form; on Save: host.setOptions({ revision: Date.now() }); host.close();
},
```

Open it with `host.openPage(params)`, from the island (a click on a record, a + button) or from
the settings panel, whose `host` has it too. `params` are short strings by name, given back as
`host.params`; the page stays as drawn (what the user typed included) while other settings change,
until `host.close()` leaves it. The settings classes above, plus `card`,
`card-foot`, `primary`, `secondary danger` and `switch`, make it look like the rest of Settings.

### Signing in to an online account

With `needs: ["oauth"]`, a plugin can sign in to a web service (Google, Microsoft, Spotify…)
with OAuth 2.0 and call its API. The app does the sign-in the way native apps should
([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)): it opens the provider's page in the
system browser, with PKCE, and receives the answer on a one-off `127.0.0.1` address. It keeps
the refresh token in the system keychain (Credential Manager, the macOS Keychain, the Secret
Service on Linux), filed under the plugin's id, and hands the plugin short-lived access tokens
only. Filing by id keeps plugins' accounts apart; it doesn't protect them from a malicious plugin,
since every plugin runs in the island's window with the same permissions: only turn on plugins
you trust.

The plugin brings the provider and its own client, registered with the provider as a desktop
app with a loopback redirect:

```js
const provider = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke", // optional: revoked on sign-out
  clientId: options.clientId,
  clientSecret: options.clientSecret,                 // optional: some providers want one
  scopes: ["https://www.googleapis.com/auth/calendar.events"],
  params: { access_type: "offline", prompt: "consent" }, // extra sign-in page parameters
};
await oauth.signIn(provider);           // opens the browser; resolves once signed in
const token = await oauth.token(provider); // null when signed out: offer to sign in
await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
```

- `token` refreshes the access token when it is about to expire. When the provider no longer
  accepts the sign-in (revoked, expired), the app forgets it and `token` returns `null`.
- The addresses must be `https://`. The provider must give a refresh token (Google: ask for
  `access_type: "offline"`), or the sign-in fails.
- Sign in from a button (in the plugin's tab or its settings panel), never on startup: it opens
  the browser.
- Web APIs are called with `fetch`, and must allow it from a web page (CORS), as Google's do.

The [Google Calendar template](https://github.com/Satcomx00-x00/AiN/tree/plugin-template-calendar)
is a complete example.

### Notifications

Any plugin can post one; no `needs` required:

```js
const n = host.notify({
  title: "Download complete",
  body: "Fedora-Workstation-44.iso",
  actions: [{ id: "open", label: "Open" }], // at most 3
  urgency: "normal",                        // "low" (history only), "normal" or "urgent"
  tag: "download",                          // a newer one with the same tag replaces it
  category: "transfer.complete",            // freedesktop's categories, for hooks to sort by
  transient: false,                         // true: shown, never kept in the history
});
n.update({ body: "Done" }); // or n.dismiss()
```

`host.notify` also takes the three standard formats as they are, and reads them as the above:
freedesktop's `Notify` arguments (`{ summary, body, app_icon, actions, hints, replaces_id }`), the
W3C's (`{ title, options }`, as in `new Notification(title, options)`) and a Windows toast's XML
(`{ toastXml, tag, group }`). What AiN has no use for (sounds, timeouts, images by URL or theme
name) is left out; an icon is drawn only when it is inline SVG.

The user decides how it shows (in the pill, as a bubble under or beside it, or as a toast in a
corner of the screen), for how long, and whether it shows at all: do not disturb, and each source
can be turned off in **Settings → Notifications**. Pressing an action calls the widget's
`onNotificationAction(notificationId, actionId)`.

With `needs: ["notifications"]`, the widget's `onNotification(n)` sees every notification from
other plugins before it shows, in the order plugins are listed, and returns it as is or changed,
`"silent"` to keep it in the history without showing it, or `null` to drop it. It can't change
who sent it, and never sees its own plugin's.

### Events

`host.on(event, listener)` returns a function that stops listening:

| Event | Payload |
| --- | --- |
| `open` | `true` when the island opens, `false` when it folds |
| `appearance` | the new `host.appearance()` |
| `options` | the plugin's options, after the user changed them |
| `unseen` | how many notifications the user hasn't seen |

### Keyboard shortcuts

A plugin can list up to 8 `commands`, each with a default shortcut the user can change in
**Settings → Shortcuts**. They open no window: the widget's `onCommand(commandId, kind)` hears
the press (`"press"`, then `"release"`), or `"tap"` from Settings' Try it button.

```js
commands: [{ id: "start", label: "Start the timer", description: "Starts a 25-minute focus.", shortcut: "Ctrl+Alt+KeyT" }],
setup: (_, host) => ({ onCommand: (id, kind) => kind !== "release" && start() }),
```

`shortcut` uses `KeyboardEvent.code` names, or `null` for none until the user picks one.

### Asking AI

With `needs: ["ai"]`, a plugin can ask the model the user picked for plugins in
**Settings → AI providers → Plugins**. It is off until they pick one: `ask` then fails, saying
where to turn it on.

```js
const answer = await ai.ask(text, { instructions: "Summarize in one sentence." });
```

At most 4 000 characters of instructions and 32 000 of text. What is asked goes to that provider.

## A notifier

A file can add a way to show notifications: its definition has `show` and no `setup`. Once the file
is on, it can be picked in **Settings → Notifications → Show as**. It draws each notification where
bubbles go, under the pill; the user's duration still applies.

```js
export default (island) =>
  island.defineNotifier({
    id: "ticker",
    label: "Ticker",
    show(stage, n, { dismiss, act }) {
      const line = island.dom.h("div", {}, `${n.source.label}: ${n.title}`);
      stage.append(line);
      return () => line.remove(); // when it leaves
    },
  });
```

If `show` throws, that notification simply doesn't show.

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

See [`examples/plugins/wave.js`](../ain/examples/plugins/wave.js).

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
  `leftFrom` / `rightFrom`, the plugin speaking), everything each spot shows side by side
  (`leftAll`, `rightAll`: `{ glance, from }` in priority order, up to the number per side picked in
  **Settings → Pill**), the tint of what is in focus (`ambient`),
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

See [`examples/plugins/neon-line.js`](../ain/examples/plugins/neon-line.js).

## The SDK

| | |
| --- | --- |
| `island.definePlugin(def)` | returns `def`; for editors that understand JSDoc types |
| `island.defineGreeting(def)` | the same, for a startup animation |
| `island.defineStyle(def)` | the same, for a pill style |
| `island.defineNotifier(def)` | the same, for a way to show notifications |
| `island.settle(animations)` | resolves once every Web Animation given has finished or been cancelled |
| `island.options` | `toggle`, `number`, `choice`, `list`, `folder`, `text`, `secret`, `color`: option fields for Settings (see [Options the user sets](#options-the-user-sets)) |
| `island.dom` | `h(tag, attrs, ...children)`, `button`, `icon`, `svg`, `tween`, `odometer`, `roll`, `reducedMotion` |
| `island.chart` | `curve`, `curveArea`, `sparkline`: SVG paths for small graphs |
| `island.color` | `isLight`, `pickColor`, `imageColor` and other color helpers |
| `island.ui.select(options, value, onChange, label)` | a drop-down list styled like the island: each option has a `label`, and optionally a `detail` line, a `meta` fact on the right and a `badge`. Returns `{ el, set, setOptions }` |
| `island.ui.glanceSlot()` | a glance spot drawn as on the Pill, for styles: `{ el, draw(glance, from) }` |
| `island.version` | `1`; it changes when the SDK changes in a way that could break plugins |

## Publish one in the community store

The store is [`store.yaml`](https://github.com/Satcomx00-x00/AiN/blob/store/store.yaml), alone on the
repository's `store` branch. AiN reads it from
`https://raw.githubusercontent.com/Satcomx00-x00/AiN/store/store.yaml` each time **Settings → Plugins**
opens; it isn't built into the app.

1. Start from the [`plugin-template`](https://github.com/Satcomx00-x00/AiN/tree/plugin-template)
   branch: a complete plugin (an analog clock) in one `index.js`, in its own GitHub repository.
2. Open a pull request against the `store` branch adding an entry:

   ```yaml
   - id: my-plugin          # 2–32 lowercase letters, digits or dashes: its folder, plugins/my-plugin/
     name: My plugin        # shown in Settings
     description: What it does, in one line.
     repo: https://github.com/you/my-plugin
     branch: main           # optional: the branch, tag or commit to install (default branch otherwise)
     entry: index.js        # optional: the plugin's file in the repository (index.js otherwise)
     options:               # optional: what the user sets up, shown before the plugin is turned on
       apiKey: { kind: secret, label: API key, required: true }
       city: { kind: text, label: City, default: "", required: true }
   ```

A plugin's code doesn't run until it is turned on, so Settings can't know its options before. List
the ones to fill in first under `options`, as the plugin's code declares them (`kind`, `label`,
`default` and the builder's other settings, with choices as `{ value, label }`; a number's `step`
is 1 if left out), and the user sets the plugin up right after installing it. Use the plugin's own
`id` as the entry's `id`: options are saved under it, so the plugin finds them once on, and its own
options then take over.

Installing downloads `entry` from `raw.githubusercontent.com`, so only GitHub repositories can be
installed from the app; others are listed with a link to install by hand. Entries are reviewed
before they're merged, since a plugin runs with the island's permissions.

## What a plugin can't do

- Use an id a built-in feature, startup animation or pill style uses (`clock`, `media`, `hello`,
  `pill`, `stub`, …), or one another plugin already took.
- Open a popup or a screen from a shortcut: their commands only reach `onCommand`.
- Ask for services other than those above.

Why a plugin was refused shows in **Settings → Plugins**.
