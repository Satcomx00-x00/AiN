# Google Calendar: an advanced AiN plugin template

Your Google Calendar on [AiN](https://github.com/Satcomx00-x00/AiN)'s island, and a starting point
for community plugins that sign in to an online account.

- **On the pill**: the event on now, with the time left and a ring that fills as it goes, or
  the next one ("Standup in 20 min"), with a ring counting down its last hour. It flashes a few
  minutes before an event starts. It can show only events on now, or how many are left today.
- **In its tab**, which opens taller than the others: a **Week** of hours with each event where it
  falls and a line at the current time, a **Month** grid (a day opens its week), or a **List** of
  what's on now or next and the days ahead, colored like your calendars. ‹ › move through time.
- **A calendar page laid out like Google Calendar**, filling the Settings window: Today, ‹ ›,
  Day / 4 days / Week / Month, a Create button, the month to jump around, your calendars to show
  or hide. Drag across the hours to create an event and fill in the popup; click one for its
  details, edit or delete it (with Undo); drag it to move it, or its bottom edge to change its end.
  Google Calendar's keys work: T, D, X, W, M, J/K, C, Esc. Dragging across the hours of the
  island's week opens it there; clicking an event opens it. From its card, type one the way you'd
  say it ("Lunch with Sam tomorrow at 1pm") and Google reads the date and time.
- **Settings**, under its switch in **Settings → Plugins**: your account, the calendars to show,
  the one new events go to, how many days ahead, the flash, what the pill says, declined events.

It follows the island's look: the theme's colors, a light or dark pill, the pill style (Stub and
Sliver, which show no text, get the countdown ring) and the pill size (shorter text at Low
profile).

It needs a version of AiN with the `oauth` service, `panelHeight` and plugin pages.

## Set it up

The plugin signs in with your own Google OAuth client, so it reads your calendar for you alone and
Google doesn't need to review it. It takes about five minutes, once:

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library**: enable the **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform): choose **External**, fill in
   the app name and your email, and keep it in **Testing**. Under **Audience → Test users**, add
   your Google account.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, of type
   **Desktop app**. Copy its client ID and client secret.
5. Install the plugin (below), turn it on in **Settings → Plugins**, and paste the client ID and
   secret in its card.
6. Click **Sign in with Google**. Your browser opens Google's sign-in page; as the app is in
   testing, Google warns that it isn't verified: continue, and allow the access asked for.

A desktop app's client secret isn't a password: Google knows such apps can't keep one. The refresh
token AiN gets is kept in your system keychain, never in the settings file. In Testing, Google
asks you to sign in again every 7 days; publishing the consent screen (still unverified, for
yourself) lifts that.

## Install it

In AiN: **Settings → Plugins → Community store → Google Calendar → Install**, then turn it on.

Or by hand: **Settings → Plugins → Open plugins folder**, make a `google-calendar` folder there,
copy [`index.js`](index.js) into it, click **Refresh** and turn it on.

## Make your own

This template shows the parts an online plugin needs:

- `needs: ["oauth"]` and the `google()` provider: signing in through the app, which opens the
  browser and keeps the refresh token in the keychain. Any OAuth 2.0 provider that allows desktop
  apps with a loopback redirect works the same way (Microsoft, Spotify, GitHub…).
- `api()`: calling a web API with the access token, and telling a signed-out user from a failure.
- `settingsPanel`: setup steps until there is a client, the account, choices that need the API
  (the calendars), and actions (adding an event). Options marked `inPanel` are drawn there.
- The `revision` option: the settings card bumps it after changing the calendar, so the island,
  which follows option changes, reads it again at once.
- `panelHeight`: a tab that needs room asks for a taller panel, and the island grows to it.
- `page`: a page of its own in the Settings window, where typing works, opened with
  `host.openPage(params)` from the island or the settings panel; it gets the whole window, here a
  full calendar.
- `tick` reading the calendar every few minutes and after any change (including moving to another
  week or month), and redrawing only when there is news; `glance` choosing what to say by the
  pill's style and size.

Change the `id`, `label`, `description` and `icon`, then the rest. The
[plugin guide](https://github.com/Satcomx00-x00/AiN/blob/main/docs/plugins.md) lists the whole
API. After changing the file, restart AiN. To list your plugin in the store, open a pull request
against the [`store`](https://github.com/Satcomx00-x00/AiN/tree/store) branch adding it to
`store.yaml`.

## Test it

`test/plugin.test.js` runs the plugin as AiN does, in a browser-like page with a fake SDK and a
fake Google Calendar: no account needed. Install [Bun](https://bun.sh), then:

```sh
bun install
bun test
```

AiN only needs `index.js`: the tests and `package.json` stay out of the plugin you install.

## License

MIT, see [LICENSE](LICENSE).
