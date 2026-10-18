// Google Calendar: an advanced template for AiN community plugins.
//
// Your Google Calendar on the island: what's on now or next, with a countdown on the pill, and the
// days ahead in its tab. Events are added from its card in Settings, by typing them the way you'd
// say them ("Lunch with Sam tomorrow at 1pm") or field by field.
//
// It shows how a plugin can sign in to an online account with the `oauth` service (the app opens
// the browser and keeps the refresh token in the system keychain), call a web API with the access
// token, keep a settings panel and the island in step, and fit the pill style, size and theme.
//
// You need your own Google OAuth client: see the README. A plugin is an ES module whose default
// export receives the island's SDK and returns a plugin definition; it runs as-is, with no build
// step. See https://github.com/Satcomx00-x00/AiN/blob/main/docs/plugins.md for the whole API.

/** @param {any} island AiN's SDK: see "The SDK" in docs/plugins.md */
export default (island) => {
  const { h, button } = island.dom;

  const API = "https://www.googleapis.com/calendar/v3";
  const MINUTE = 60_000;
  const DAY = 24 * 60 * MINUTE;
  /** How often the island reads the calendar again, and how soon after a failure. */
  const REFRESH = 5 * MINUTE;
  const RETRY = MINUTE;
  /** Pill styles that draw marks and progress but no text. */
  const TEXTLESS = new Set(["stub", "sliver"]);
  /** What `host.appearance()` says on versions of AiN before it existed. */
  const PLAIN = { style: "pill", size: "normal", theme: "island", tone: "dark", notch: false };
  /** How long a title may be on the pill, by pill size. */
  const TITLE = { low: 10, normal: 16, large: 24 };

  /** Google's OAuth endpoints, with the user's own client. */
  const google = (o) => ({
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    clientId: o.clientId,
    clientSecret: o.clientSecret || null,
    // Read the calendar list; read and write events.
    scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"],
    // A refresh token, so the user signs in once.
    params: { access_type: "offline", prompt: "consent" },
  });

  /** The user has to sign in (again). */
  class SignedOut extends Error {}

  /** Calls the Calendar API as the signed-in user. */
  const api = async (oauth, o, path, init = {}) => {
    const token = await oauth.token(google(o));
    if (!token) throw new SignedOut("not signed in");
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
    if (response.status === 401) throw new SignedOut("signed out");
    if (!response.ok) {
      const why = await response.json().then((b) => b?.error?.message, () => null);
      throw new Error(why || `Google answered ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  };

  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  const dayMonth = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  const startOfDay = (t) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();
  /** "2026-10-17" as local midnight, the way all-day events are meant. */
  const localDate = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  const isoDate = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  /** "Today", "Tomorrow", "Sunday", then "Mon 27 Oct". */
  const dayLabel = (t, now) => {
    const days = Math.round((startOfDay(t) - startOfDay(now)) / DAY);
    return days === 0 ? "Today" : days === 1 ? "Tomorrow" : days < 7 ? weekday.format(t) : dayMonth.format(t);
  };
  /** "25 min", "1 h 05", "3 h". */
  const span = (ms) => {
    const m = Math.max(1, Math.round(ms / MINUTE));
    if (m < 60) return `${m} min`;
    const rest = m % 60;
    return rest ? `${Math.floor(m / 60)} h ${String(rest).padStart(2, "0")}` : `${m / 60} h`;
  };
  const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

  /** An event from the API, flattened for drawing. */
  const flatten = (item, calendar) => {
    const allDay = !item.start.dateTime;
    return {
      id: item.id,
      calendar: calendar.id,
      color: calendar.backgroundColor || "var(--accent)",
      title: item.summary || "(No title)",
      location: item.location || "",
      allDay,
      start: allDay ? localDate(item.start.date) : Date.parse(item.start.dateTime),
      end: allDay ? localDate(item.end.date) : Date.parse(item.end.dateTime),
      declined: (item.attendees ?? []).some((a) => a.self && a.responseStatus === "declined"),
    };
  };

  /** The calendars the options pick: "primary" stands for the account's own. */
  const picked = (list, ids) => list.filter((c) => ids.includes(c.id) || (c.primary && ids.includes("primary")));

  // Plugins bring their own styles; the island's colors follow the theme.
  const CSS = `
    .gcal { display: grid; grid-template-columns: 150px 1fr; grid-template-rows: 1fr auto; gap: 6px 14px; height: 100%; min-height: 0; }
    .gcal-focus { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 8px 10px; border-radius: 12px;
      background: color-mix(in srgb, var(--event, var(--accent)) 16%, transparent); border-left: 3px solid var(--event, var(--accent)); }
    .gcal[data-tone="light"] .gcal-focus { background: color-mix(in srgb, var(--event, var(--accent)) 22%, transparent); }
    .gcal-kicker { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--event, var(--accent)); }
    .gcal-title { font-size: 14px; font-weight: 650; line-height: 1.2; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .gcal-when { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .gcal-bar { margin-top: auto; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--fg) 12%, transparent); overflow: hidden; }
    .gcal-bar i { display: block; height: 100%; width: calc(var(--p, 0) * 100%); background: var(--event, var(--accent)); }
    .gcal-list { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 2px; scrollbar-width: thin; }
    .gcal-day { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-top: 4px; }
    .gcal-day:first-child { margin-top: 0; }
    .gcal-row { display: grid; grid-template-columns: 3px 64px 1fr; gap: 8px; align-items: baseline; font-size: 12px; line-height: 1.5; }
    .gcal-row::before { content: ""; align-self: stretch; border-radius: 2px; background: var(--event); }
    .gcal-row time { color: var(--muted); font-variant-numeric: tabular-nums; }
    .gcal-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gcal-row[data-now="true"] span { font-weight: 650; }
    .gcal-row[data-past="true"] { opacity: .45; }
    .gcal-foot { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted); }
    .gcal-foot .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gcal-foot[data-failed="true"] .grow { color: var(--hot); }
    .gcal button { border: 0; border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 11px; cursor: pointer;
      color: var(--fg); background: color-mix(in srgb, var(--fg) 10%, transparent); }
    .gcal button:hover { background: color-mix(in srgb, var(--fg) 18%, transparent); }
    .gcal button.primary { background: var(--accent); color: var(--on-accent, #fff); }
    .gcal-empty { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; font-size: 13px; color: var(--muted); }`;

  // The settings card's own controls, drawn in the settings window's style.
  const SETTINGS_CSS = `
    .gcal-settings { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 8px; }
    .gcal-settings .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .gcal-settings .grow { flex: 1; min-width: 0; }
    .gcal-settings .path-input { flex: 1; min-width: 120px; }
    .gcal-settings input[type="date"], .gcal-settings input[type="time"], .gcal-settings select { width: auto; flex: none; }
    .gcal-settings .calendars { display: flex; flex-direction: column; gap: 4px; }
    .gcal-settings label.calendar { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .gcal-settings .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--dot); flex: none; }
    .gcal-settings .failed { color: var(--hot); }
    .gcal-settings ol { margin: 0; padding-left: 18px; }`;

  return island.definePlugin({
    id: "google-calendar",
    label: "Google Calendar",
    description: "Your next events on the pill, the days ahead in a tab, and quick adding from Settings.",
    icon: `<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/><path d="M5.5 9h2v2h-2z"/>`,
    slots: ["glance", "tab"],
    // The service that signs it in, filed under this plugin's id.
    needs: ["oauth"],
    // Drawn in Settings under the plugin's switch, in this order; options marked `inPanel` are
    // drawn by `settingsPanel` instead, which sits where the first of them is.
    options: {
      clientId: island.options.text("Client ID", "", "1234-abc.apps.googleusercontent.com", "From a Desktop app OAuth client in Google Cloud: see the README."),
      clientSecret: island.options.text("Client secret", "", "GOCSPX-…", "Google gives Desktop app clients one too; it isn't a password."),
      calendars: { ...island.options.list("Calendars", ["primary"]), inPanel: true },
      addTo: { ...island.options.text("Add events to", "primary"), inPanel: true },
      // Bumped by the settings card after it changes the calendar, so the island reads it again now.
      revision: { ...island.options.number("Revision", 0, { min: 0, max: Number.MAX_SAFE_INTEGER }), inPanel: true },
      days: island.options.number("Days ahead", 3, { min: 1, max: 14, unit: "days" }, "Shown in the tab."),
      remind: island.options.number("Flash before an event", 5, { min: 0, max: 30, step: 5, unit: "min" }, "The pill asks for attention; 0 for never."),
      pill: island.options.choice(
        "On the pill",
        "next",
        [
          ["next", "Next event"],
          ["now", "Only during one"],
          ["left", "Events left today"],
        ],
        "Stub and Sliver show a countdown ring instead of text.",
      ),
      declined: island.options.toggle("Hide declined events", true),
    },

    // The account, the calendars to show and adding events, in the plugin's Settings card.
    settingsPanel(root, { oauth }, host) {
      const account = h("div", { class: "row" });
      const calendars = h("div", { class: "calendars" });
      const target = h("div", { class: "row" });
      const adding = h("div", { class: "gcal-settings-add" });
      const result = h("div", { class: "row field-hint" });
      root.append(h("style", {}, SETTINGS_CSS), h("div", { class: "gcal-settings" }, account, calendars, target, adding, result));

      let busy = false;
      let list = [];
      /** Asks the island to read the calendar again, now. */
      const nudge = () => host.setOptions({ revision: Date.now() });
      const fail = (where, e) => where.replaceChildren(h("span", { class: "failed" }, e instanceof SignedOut ? "Signed out: sign in again." : `Couldn't do it: ${e.message ?? e}`));

      /** The setup steps, while there is no client. */
      const setup = () => {
        account.replaceChildren(
          h(
            "div",
            { class: "field-hint" },
            "To sign in, this plugin needs your own Google OAuth client:",
            h(
              "ol",
              {},
              h("li", {}, "In Google Cloud Console, create a project and enable the Google Calendar API."),
              h("li", {}, "Set up the OAuth consent screen (External, Testing) and add yourself as a test user."),
              h("li", {}, "Create an OAuth client ID of type Desktop app."),
              h("li", {}, "Paste its client ID and secret above."),
            ),
          ),
        );
        for (const el of [calendars, target, adding]) el.replaceChildren();
      };

      const draw = async () => {
        const o = host.options();
        if (!o.clientId) return setup();
        const signedIn = await oauth.signedIn(google(o));
        account.replaceChildren(
          h("span", { class: "grow" }, busy ? "Waiting for the browser…" : signedIn ? "Signed in to Google Calendar." : "Not signed in."),
          signedIn
            ? button("Sign out", () => void oauth.signOut(google(o)).then(() => (nudge(), draw())), { class: "secondary" })
            : button("Sign in with Google", signIn, { class: "secondary", ...(busy ? { disabled: "" } : {}) }),
        );
        if (!signedIn) {
          for (const el of [calendars, target, adding]) el.replaceChildren();
          return;
        }
        try {
          list = (await api(oauth, o, "/users/me/calendarList?fields=items(id,summary,backgroundColor,primary,accessRole)")).items ?? [];
        } catch (e) {
          return fail(calendars, e);
        }
        drawCalendars();
        drawAdding();
      };

      const signIn = async () => {
        busy = true;
        void draw();
        try {
          await oauth.signIn(google(host.options()));
          nudge();
        } catch (e) {
          fail(result, e);
        } finally {
          busy = false;
          void draw();
        }
      };

      /** A checkbox per calendar; the account's own one stays "primary" in the options. */
      const drawCalendars = () => {
        const ids = host.options().calendars;
        const idOf = (c) => (c.primary ? "primary" : c.id);
        calendars.replaceChildren(
          h("div", { class: "field-label" }, "Calendars"),
          ...list.map((c) => {
            const box = h("input", { type: "checkbox" });
            box.checked = picked([c], ids).length > 0;
            box.addEventListener("change", () => {
              const now = host.options().calendars.filter((id) => id !== idOf(c) && id !== c.id);
              host.setOptions({ calendars: box.checked ? [...now, idOf(c)] : now });
            });
            return h("label", { class: "calendar" }, box, h("span", { class: "dot", style: `--dot: ${c.backgroundColor}` }), c.summary);
          }),
        );
        const writable = list.filter((c) => c.accessRole === "owner" || c.accessRole === "writer");
        const options = writable.map((c) => ({ value: c.primary ? "primary" : c.id, label: c.summary, ...(c.primary ? { detail: "Your calendar" } : {}) }));
        const chosen = options.some((x) => x.value === host.options().addTo) ? host.options().addTo : "primary";
        target.replaceChildren(
          h("span", { class: "field-label grow" }, "Add events to"),
          island.ui.select(options, chosen, (addTo) => host.setOptions({ addTo }), "Add events to").el,
        );
      };

      /** What was just added, with a way to take it back. */
      const added = (event, calendarId) => {
        const when = event.start?.dateTime ? `${dayMonth.format(Date.parse(event.start.dateTime))}, ${time.format(Date.parse(event.start.dateTime))}` : event.start?.date ?? "";
        result.replaceChildren(
          h("span", { class: "grow" }, `Added “${event.summary || "(No title)"}”${when ? `, ${when}` : ""}.`),
          button("Undo", async () => {
            try {
              await api(oauth, host.options(), `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}`, { method: "DELETE" });
              result.replaceChildren(h("span", {}, "Removed."));
              nudge();
            } catch (e) {
              fail(result, e);
            }
          }, { class: "secondary" }),
        );
        nudge();
      };

      /** Adding by sentence (Google reads the date and time in it), or field by field. */
      const drawAdding = () => {
        const sentence = h("input", { class: "path-input", type: "text", placeholder: "Lunch with Sam tomorrow at 1pm", "aria-label": "New event" });
        const quick = async () => {
          const text = sentence.value.trim();
          if (!text) return sentence.focus();
          const calendarId = host.options().addTo || "primary";
          try {
            const event = await api(oauth, host.options(), `/calendars/${encodeURIComponent(calendarId)}/events/quickAdd?text=${encodeURIComponent(text)}`, { method: "POST" });
            sentence.value = "";
            added(event, calendarId);
          } catch (e) {
            fail(result, e);
          }
        };
        sentence.addEventListener("keydown", (e) => e.key === "Enter" && void quick());

        const now = new Date(Date.now() + 60 * MINUTE);
        const title = h("input", { class: "path-input", type: "text", placeholder: "Title", "aria-label": "Title" });
        const date = h("input", { class: "path-input", type: "date", value: isoDate(now), "aria-label": "Date" });
        const start = h("input", { class: "path-input", type: "time", value: `${String(now.getHours()).padStart(2, "0")}:00`, "aria-label": "Start" });
        const length = h(
          "select",
          { class: "path-input", "aria-label": "Duration" },
          ...[
            ["30", "30 min"],
            ["60", "1 h"],
            ["90", "1 h 30"],
            ["120", "2 h"],
            ["day", "All day"],
          ].map(([value, label]) => h("option", { value }, label)),
        );
        length.value = "60";
        const detailed = async () => {
          if (!title.value.trim() || !date.value) return title.focus();
          const calendarId = host.options().addTo || "primary";
          const allDay = length.value === "day";
          const from = new Date(`${date.value}T${start.value || "09:00"}`).getTime();
          const body = allDay
            ? { summary: title.value.trim(), start: { date: date.value }, end: { date: isoDate(localDate(date.value) + DAY + 2 * 60 * MINUTE) } }
            : { summary: title.value.trim(), start: { dateTime: new Date(from).toISOString() }, end: { dateTime: new Date(from + Number(length.value) * MINUTE).toISOString() } };
          try {
            const event = await api(oauth, host.options(), `/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", body: JSON.stringify(body) });
            title.value = "";
            added(event, calendarId);
          } catch (e) {
            fail(result, e);
          }
        };

        adding.replaceChildren(
          h("div", { class: "field-label" }, "Add an event"),
          h("div", { class: "row" }, sentence, button("Add", () => void quick(), { class: "secondary" })),
          h("div", { class: "field-hint" }, "Or in detail:"),
          h("div", { class: "row" }, title, date, start, length, button("Add", () => void detailed(), { class: "secondary" })),
        );
      };

      // The client is typed in the standard fields above, which don't redraw this card: watch it.
      let client = "";
      const watch = setInterval(() => {
        const o = host.options();
        if (`${o.clientId}|${o.clientSecret}` === client) return;
        client = `${o.clientId}|${o.clientSecret}`;
        void draw();
      }, 1000);
      client = `${host.options().clientId}|${host.options().clientSecret}`;
      void draw();
      return () => clearInterval(watch);
    },

    setup({ oauth }, host) {
      const look = () => host.appearance?.() ?? PLAIN;
      /** The events from today to `days` ahead, soonest first, and how reading them last went. */
      let events = [];
      let problem = null;
      let fetchedAt = 0;
      let syncing = false;
      let nextSync = 0;
      let synced = "";
      /** Bumped when there is something new to draw in the tab. */
      let version = 0;
      let drawn = "";

      /** What a sync depends on: a change reads the calendar again at once. */
      const signature = (o) => [o.clientId, o.clientSecret, o.calendars.join(","), o.days, o.declined, o.revision].join("|");

      const sync = async () => {
        const o = host.options();
        syncing = true;
        synced = signature(o);
        try {
          if (!o.clientId) throw Object.assign(new Error("setup"), { setup: true });
          const list = (await api(oauth, o, "/users/me/calendarList?fields=items(id,backgroundColor,primary)")).items ?? [];
          const from = startOfDay(Date.now());
          const query = new URLSearchParams({
            timeMin: new Date(from).toISOString(),
            timeMax: new Date(from + o.days * DAY).toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "100",
            fields: "items(id,summary,location,start,end,attendees(self,responseStatus))",
          });
          const each = await Promise.all(
            picked(list, o.calendars).map((c) =>
              api(oauth, o, `/calendars/${encodeURIComponent(c.id)}/events?${query}`).then((r) => (r.items ?? []).map((item) => flatten(item, c))),
            ),
          );
          events = each.flat().filter((e) => !(o.declined && e.declined)).sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
          problem = null;
          fetchedAt = Date.now();
          nextSync = fetchedAt + REFRESH;
        } catch (e) {
          problem = e.setup ? "setup" : e instanceof SignedOut ? "signin" : e.message || String(e);
          if (problem === "setup" || problem === "signin") events = [];
          nextSync = Date.now() + RETRY;
        } finally {
          syncing = false;
          version++;
          host.refresh();
        }
      };

      /** The event on now (not all-day), and the next one to start. */
      const around = (now) => ({
        current: events.find((e) => !e.allDay && e.start <= now && now < e.end),
        next: events.find((e) => !e.allDay && e.start > now),
      });

      // The tab: what's on now or next, and the days ahead.
      const root = h("div", { class: "gcal" });
      const bar = h("i");

      /** A message in place of the calendar, with what to do about it. */
      const empty = (text, ...actions) => root.replaceChildren(h("div", { class: "gcal-empty" }, h("span", {}, text), ...(actions.length ? [h("div", {}, ...actions)] : [])));

      const signIn = async () => {
        empty("Waiting for the browser…");
        try {
          await oauth.signIn(google(host.options()));
          await sync();
        } catch (e) {
          empty(`Not signed in: ${e.message ?? e}`, button("Try again", () => void signIn(), { class: "primary" }));
        }
      };

      const draw = (now) => {
        const tone = look().tone;
        root.dataset.tone = tone;
        if (problem === "setup") return empty("Add your Google OAuth client in Settings to begin.", button("Set up", () => host.openSettings(), { class: "primary" }));
        if (problem === "signin") return empty("Sign in to see your calendar here.", button("Sign in with Google", () => void signIn(), { class: "primary" }));
        if (!fetchedAt) return empty("Reading your calendar…");

        const { current, next } = around(now);
        const shown = current ?? next;
        const focus = h(
          "div",
          { class: "gcal-focus", style: shown ? `--event: ${shown.color}` : "" },
          h("div", { class: "gcal-kicker" }, current ? "Now" : next ? (startOfDay(next.start) === startOfDay(now) ? "Next" : dayLabel(next.start, now)) : "Free"),
          h("div", { class: "gcal-title" }, shown ? shown.title : "Nothing else planned"),
          h("div", { class: "gcal-when" }, shown ? `${time.format(shown.start)} – ${time.format(shown.end)}` : ""),
          ...(current ? [h("div", { class: "gcal-bar" }, bar)] : []),
        );

        const list = h("div", { class: "gcal-list" });
        let day = -1;
        for (const e of events.filter((e) => e.end > startOfDay(now))) {
          const d = Math.max(startOfDay(e.start), startOfDay(now));
          if (d !== day) {
            day = d;
            list.append(h("div", { class: "gcal-day" }, dayLabel(d, now)));
          }
          list.append(
            h(
              "div",
              { class: "gcal-row", style: `--event: ${e.color}`, "data-now": String(e === current), "data-past": String(!e.allDay && e.end <= now) },
              h("time", {}, e.allDay ? "All day" : time.format(e.start)),
              h("span", { title: e.location ? `${e.title} · ${e.location}` : e.title }, e.title),
            ),
          );
        }
        if (!list.childElementCount) list.append(h("div", { class: "gcal-day" }, "No events"));

        const foot = h(
          "div",
          { class: "gcal-foot", "data-failed": String(Boolean(problem)) },
          h("span", { class: "grow" }, problem ? `Couldn't update: ${problem}` : `Updated ${time.format(fetchedAt)}`),
          button("Refresh", () => void sync()),
          button("Add event", () => host.openSettings(), { class: "primary" }),
        );
        root.replaceChildren(focus, list, foot);
      };

      return {
        panel(el) {
          el.append(h("style", {}, CSS), root);
        },

        tick({ now, visible }) {
          const o = host.options();
          if (!syncing && (now >= nextSync || signature(o) !== synced)) void sync();
          if (!visible) return;
          // Redrawn when there is news, or a new minute; the bar moves every second.
          const key = `${version}|${Math.floor(now / MINUTE)}|${look().tone}`;
          if (key !== drawn) {
            drawn = key;
            draw(now);
          }
          const { current } = around(now);
          if (current) bar.style.setProperty("--p", String((now - current.start) / (current.end - current.start)));
        },

        glance(now) {
          if (problem === "setup" || problem === "signin") return null;
          const o = host.options();
          const { style, size } = look();
          const textless = TEXTLESS.has(style);
          const n = TITLE[size] ?? TITLE.normal;
          const { current, next } = around(now);

          if (o.pill === "left") {
            const left = events.filter((e) => !e.allDay && e.end > now && startOfDay(e.start) === startOfDay(now)).length;
            return left ? { text: `${left} left today` } : null;
          }
          if (current) {
            const progress = (now - current.start) / (current.end - current.start);
            const text = size === "low" ? `${span(current.end - now)} left` : `${short(current.title, n)} · ${span(current.end - now)}`;
            return { text, progress };
          }
          if (o.pill === "now" || !next) return null;
          const until = next.start - now;
          // Within the hour, a ring counts down to it; Stub and Sliver show only that.
          const soon = until <= 60 * MINUTE;
          if (textless && !soon) return null;
          const when = soon ? `in ${span(until)}` : startOfDay(next.start) === startOfDay(now) ? `at ${time.format(next.start)}` : dayLabel(next.start, now);
          return {
            text: size === "low" ? when : `${short(next.title, n)} ${when}`,
            ...(soon && { progress: 1 - until / (60 * MINUTE) }),
            ...(o.remind > 0 && until <= o.remind * MINUTE && { tone: "alert" }),
          };
        },
      };
    },
  });
};
