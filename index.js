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

  /** `t` moved by `n` days, at the same local time even across a daylight saving change. */
  const addDays = (t, n) => {
    const d = new Date(t);
    d.setDate(d.getDate() + n);
    return d.getTime();
  };
  /** The day weeks start on where the user lives, as `getDay()` counts (0 is Sunday): Monday unless their locale says otherwise. */
  const FIRST_DAY = (() => {
    try {
      const locale = new Intl.Locale(navigator.language);
      return ((locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 1) % 7;
    } catch {
      return 1;
    }
  })();
  const startOfWeek = (t) => addDays(startOfDay(t), -((new Date(t).getDay() - FIRST_DAY + 7) % 7));
  const startOfMonth = (t) => new Date(new Date(t).getFullYear(), new Date(t).getMonth(), 1).getTime();
  const monthTitle = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  const dayShort = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const dayNumber = new Intl.DateTimeFormat(undefined, { day: "numeric" });
  const dayAndMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const hourLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
  /** Whether `e` is on during the day starting at `day`. */
  const onDay = (e, day) => e.start < addDays(day, 1) && e.end > day;

  /** Side by side when they overlap: each event's lane, and how many lanes its group needs. */
  const lanes = (list) => {
    const out = [];
    let group = [];
    let groupEnd = 0;
    const close = () => {
      const n = Math.max(...group.map((x) => x.lane)) + 1;
      for (const x of group) x.of = n;
      group = [];
    };
    for (const x of [...list].sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (group.length && x.start >= groupEnd) close();
      const taken = new Set(group.filter((y) => y.end > x.start).map((y) => y.lane));
      let lane = 0;
      while (taken.has(lane)) lane++;
      group.push(Object.assign(x, { lane }));
      out.push(x);
      groupEnd = Math.max(groupEnd, x.end);
    }
    if (group.length) close();
    return out;
  };

  /** Pixels per hour in the week's grid. */
  const HOUR_PX = 26;

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
    .gcal { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
    .gcal button { border: 0; border-radius: 8px; padding: 3px 9px; font: inherit; font-size: 11.5px; cursor: pointer;
      color: var(--fg); background: color-mix(in srgb, var(--fg) 9%, transparent); }
    .gcal button:hover { background: color-mix(in srgb, var(--fg) 17%, transparent); }
    .gcal button.primary { background: var(--accent); color: var(--on-accent, #fff); }
    .gcal-top { display: flex; align-items: center; gap: 6px; flex: none; }
    .gcal-views { display: flex; padding: 2px; border-radius: 9px; background: color-mix(in srgb, var(--fg) 7%, transparent); }
    .gcal .gcal-views button { background: none; color: var(--muted); padding: 3px 8px; border-radius: 7px; }
    .gcal .gcal-views button[aria-pressed="true"] { background: color-mix(in srgb, var(--fg) 14%, transparent); color: var(--fg); }
    .gcal .gcal-nav { width: 24px; padding: 3px 0; }
    .gcal-range { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-transform: capitalize; }
    .gcal-range small { font-weight: 500; color: var(--muted); margin-left: 6px; text-transform: none; }
    .gcal-range small[data-failed="true"] { color: var(--hot); }
    .gcal-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }

    .gcal-agenda { flex: 1; min-height: 0; display: grid; grid-template-columns: 150px 1fr; gap: 14px; }
    .gcal-focus { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 8px 10px; border-radius: 12px; align-self: start;
      background: color-mix(in srgb, var(--event, var(--accent)) 16%, transparent); border-left: 3px solid var(--event, var(--accent)); }
    .gcal[data-tone="light"] .gcal-focus { background: color-mix(in srgb, var(--event, var(--accent)) 22%, transparent); }
    .gcal-kicker { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--event, var(--accent)); }
    .gcal-title { font-size: 14px; font-weight: 650; line-height: 1.2; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
    .gcal-when { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .gcal-bar { margin-top: 4px; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--fg) 12%, transparent); overflow: hidden; }
    .gcal-bar i { display: block; height: 100%; width: calc(var(--p, 0) * 100%); background: var(--event, var(--accent)); }
    .gcal-list { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 2px; scrollbar-width: thin; }
    .gcal-day { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-top: 6px; }
    .gcal-day:first-child { margin-top: 0; }
    .gcal-row { display: grid; grid-template-columns: 3px 64px 1fr; gap: 8px; align-items: baseline; font-size: 12px; line-height: 1.5; }
    .gcal-row::before { content: ""; align-self: stretch; border-radius: 2px; background: var(--event); }
    .gcal-row time { color: var(--muted); font-variant-numeric: tabular-nums; }
    .gcal-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gcal-row[data-now="true"] span { font-weight: 650; }
    .gcal-row[data-past="true"] { opacity: .45; }

    .gw { --gutter: 30px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .gw-head, .gw-allday { display: grid; grid-template-columns: var(--gutter) repeat(7, minmax(0, 1fr)); flex: none; }
    .gw-day { display: flex; flex-direction: column; align-items: center; gap: 1px; padding-bottom: 4px; font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
    .gw-day b { font-size: 13px; font-weight: 650; color: var(--fg); letter-spacing: 0; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; }
    .gw-day[data-today="true"] { color: var(--accent); }
    .gw-day[data-today="true"] b { background: var(--accent); color: var(--on-accent, #fff); }
    .gw-allday { border-top: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); padding: 2px 0; }
    .gw-allday > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 0 1px; }
    .gw-chip { display: block; padding: 0 4px; border-radius: 4px; font-size: 10px; line-height: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      background: color-mix(in srgb, var(--event) 32%, transparent); }
    .gw-grid { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; border-top: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); }
    .gw-inner { position: relative; display: grid; grid-template-columns: var(--gutter) repeat(7, minmax(0, 1fr));
      background: repeating-linear-gradient(to bottom, color-mix(in srgb, var(--fg) 7%, transparent) 0 1px, transparent 1px ${HOUR_PX}px); }
    .gw-hours { position: relative; }
    .gw-hours span { position: absolute; right: 5px; transform: translateY(-50%); font-size: 9.5px; color: var(--muted); }
    .gw-col { position: relative; border-left: 1px solid color-mix(in srgb, var(--fg) 7%, transparent); }
    .gw-col[data-today="true"] { background: color-mix(in srgb, var(--accent) 6%, transparent); }
    .gw-ev { position: absolute; box-sizing: border-box; padding: 1px 3px; border-radius: 4px; overflow: hidden; font-size: 10px; line-height: 1.2;
      background: color-mix(in srgb, var(--event) 34%, var(--bg, #000)); border-left: 2px solid var(--event); }
    .gw-ev b { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gw-ev span { color: var(--muted); }
    .gw-ev[data-past="true"] { opacity: .55; }
    .gw-now { position: absolute; left: 0; right: 0; height: 2px; background: var(--hot); z-index: 1; pointer-events: none; }
    .gw-now::before { content: ""; position: absolute; left: -3px; top: -2px; width: 6px; height: 6px; border-radius: 50%; background: var(--hot); }

    .gm { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); grid-template-rows: auto; gap: 2px; }
    .gm-dow { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; text-align: center; padding-bottom: 2px; }
    .gcal .gm-cell { display: flex; flex-direction: column; align-items: stretch; gap: 1px; min-width: 0; min-height: 0; overflow: hidden; padding: 2px 3px;
      border-radius: 6px; background: color-mix(in srgb, var(--fg) 4%, transparent); text-align: left; }
    .gcal .gm-cell:hover { background: color-mix(in srgb, var(--fg) 10%, transparent); }
    .gm-cell[data-out="true"] { opacity: .4; }
    .gm-top { display: flex; align-items: center; justify-content: space-between; gap: 2px; }
    .gm-num { font-size: 10.5px; font-weight: 650; line-height: 15px; }
    .gm-cell[data-today="true"] .gm-num { align-self: flex-start; padding: 0 5px; border-radius: 8px; background: var(--accent); color: var(--on-accent, #fff); }
    .gm-ev { display: block; padding: 0 3px; border-radius: 3px; font-size: 9.5px; line-height: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      border-left: 2px solid var(--event); background: color-mix(in srgb, var(--event) 18%, transparent); }
    .gm-more { font-size: 9.5px; line-height: 12px; color: var(--muted); }

    .gcal-row, .gcal-focus[data-open="true"], .gw-ev, .gw-chip, .gm-ev { cursor: pointer; }
    .gcal-row:hover span, .gcal-focus[data-open="true"]:hover .gcal-title { text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--fg) 40%, transparent); }
    .gw-ev:hover, .gw-chip:hover, .gm-ev:hover { filter: brightness(1.25); }
    .gw-col { cursor: crosshair; touch-action: none; }
    .gw-sel { position: absolute; left: 1px; right: 1px; border-radius: 4px; pointer-events: none; z-index: 2;
      background: color-mix(in srgb, var(--accent) 40%, transparent); border: 1px solid var(--accent); }
    .gcal-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; font-size: 13px; color: var(--muted); }`;

  // The settings card's own rows: the settings window's `field` rows (label and hint, then the
  // control), so they line up with the standard options around them.
  const SETTINGS_CSS = `
    .gcal-settings .gcal-control { box-sizing: border-box; height: 32px; min-width: 0; padding: 0 10px; border: 1px solid var(--line);
      border-radius: 8px; background: rgba(255, 255, 255, 0.04); font-size: 13px; }
    .gcal-settings .gcal-control:focus { border-color: var(--accent); outline: none; }
    .gcal-settings .gcal-control::placeholder { color: var(--muted); }
    .gcal-settings .secondary { box-sizing: border-box; height: 32px; padding: 0 14px; white-space: nowrap; }
    .gcal-settings .gcal-target { max-width: 280px; }
    .gcal-settings .gcal-line { display: flex; align-items: center; gap: 8px; }
    .gcal-settings .gcal-line > input { flex: 1; }
    .gcal-settings .gcal-or { font-size: 12px; color: var(--muted); }
    .gcal-settings .gcal-calendars { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px 16px; }
    .gcal-settings label.calendar { display: flex; align-items: center; gap: 8px; min-width: 0; cursor: pointer; font-size: 13px; }
    .gcal-settings label.calendar span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gcal-settings label.calendar input { margin: 0; accent-color: var(--accent); }
    .gcal-settings .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--dot); flex: none; }
    .gcal-settings .gcal-result { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); }
    .gcal-settings .gcal-result:empty { display: none; }
    .gcal-settings .failed { color: var(--hot); }
    .gcal-settings ol { margin: 6px 0 0; padding-left: 18px; line-height: 1.6; }`;

  /** A row like the settings window's own: label and hint, then the control (below them when wide). */
  const field = (label, hint, control, wide = false) =>
    h(
      "div",
      { class: wide ? "field wide" : "field" },
      h("div", {}, h("div", { class: "field-label" }, label), ...(hint ? [hint instanceof Node ? hint : h("div", { class: "field-hint" }, hint)] : [])),
      ...[control].flat(),
    );

  // ---------- The calendar page: Google Calendar's layout, in the whole Settings window ----------

  /** Pixels per hour in the page's time grid, and the minutes drags snap to. */
  const HOUR_H = 48;
  const SNAP = 15;
  const fullDay = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
  const longDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });
  const monthShort = new Intl.DateTimeFormat(undefined, { month: "short" });
  const yearOnly = new Intl.DateTimeFormat(undefined, { year: "numeric" });
  const dayLetter = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
  const zoneName = (() => {
    try {
      return new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(Date.now()).find((p) => p.type === "timeZoneName")?.value ?? "";
    } catch {
      return "";
    }
  })();
  /** The page's views, with the key that shows each, as in Google Calendar. */
  const VIEWS = {
    day: { label: "Day", key: "D" },
    week: { label: "Week", key: "W" },
    month: { label: "Month", key: "M" },
    four: { label: "4 days", key: "X" },
  };
  /** Stroke icons on a 24 grid. */
  const ICONS = {
    back: `<path d="M19 12H5M11 6l-6 6 6 6"/>`,
    menu: `<path d="M4 7h16M4 12h16M4 17h16"/>`,
    prev: `<path d="M14.5 6l-6 6 6 6"/>`,
    next: `<path d="M9.5 6l6 6-6 6"/>`,
    refresh: `<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>`,
    down: `<path d="M7 10l5 5 5-5"/>`,
    plus: `<path d="M12 5v14M5 12h14"/>`,
    close: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
    edit: `<path d="M4 20h4L18.5 9.5l-4-4L4 16z"/><path d="M13 7l4 4"/>`,
    trash: `<path d="M5 7h14M10 11v6M14 11v6M6.5 7l1 13h9l1-13M9 7V4.5h6V7"/>`,
    clock: `<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>`,
    place: `<path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.2"/>`,
    notes: `<path d="M5 7h14M5 12h14M5 17h9"/>`,
    calendar: `<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/>`,
    repeat: `<path d="M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4v-1"/>`,
  };
  /** An icon (from the constants above, never from data). */
  const icon = (name, size = 20) => {
    const span = h("span", { class: "gc-i", "aria-hidden": "true" });
    span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  };
  /** A button with any content; `button` from the SDK takes a single label. */
  const btn = (attrs, kids, onClick) => {
    const b = h("button", { type: "button", ...attrs }, ...[kids].flat());
    if (onClick) b.addEventListener("click", onClick);
    return b;
  };
  const iconButton = (name, label, onClick, size = 20) => btn({ class: "gc-ib", "aria-label": label, title: label }, icon(name, size), onClick);
  /** A description as plain text: Google keeps some as HTML. */
  const plain = (html) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  /** An event that goes in the all-day row: all day, or a day long or more. */
  const isBar = (e) => e.allDay || e.end - e.start >= DAY;
  /** Lays bars out in rows over `n` days from `from`: each bar's first and last-but-one column, and its row. */
  const stack = (list, from, n) => {
    const rows = [];
    return [...list]
      .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
      .map((e) => {
        const c0 = Math.max(0, Math.round((startOfDay(e.start) - from) / DAY));
        const last = e.allDay || startOfDay(e.end) === e.end ? e.end : addDays(startOfDay(e.end), 1);
        const c1 = Math.max(c0 + 1, Math.min(n, Math.round((last - from) / DAY)));
        let row = 0;
        while ((rows[row] ?? []).some(([a, b]) => a < c1 && c0 < b)) row++;
        (rows[row] ??= []).push([c0, c1]);
        return { e, c0, c1, row };
      });
  };
  /** "Sunday, 18 October · 14:00 – 15:30", or the days it spans. */
  const whenText = (e) => {
    if (e.allDay) {
      const last = addDays(e.end, -1);
      return last <= e.start ? fullDay.format(e.start) : `${dayAndMonth.format(e.start)} – ${dayAndMonth.format(last)}`;
    }
    if (startOfDay(e.start) === startOfDay(e.end - 1)) return `${fullDay.format(e.start)} · ${time.format(e.start)} – ${time.format(e.end)}`;
    return `${dayAndMonth.format(e.start)}, ${time.format(e.start)} – ${dayAndMonth.format(e.end)}, ${time.format(e.end)}`;
  };

  const GC_CSS = `
    .gc, .gc-pop { --bg: #131314; --raised: #282a2c; --field: #333537; --line: #3c4043; --text: #e3e3e3; --soft: #c4c7c5; --muted: #8e918f;
      --accent: #a8c7fa; --on-accent: #062e6f; --hover: rgba(227, 227, 227, .08); --red: #ea4335; --gutter: 64px;
      font: 14px/1.4 "Google Sans", Roboto, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
    .gc { height: 100%; display: grid; grid-template-columns: 256px minmax(0, 1fr); grid-template-rows: 64px minmax(0, 1fr);
      background: var(--bg); color: var(--text); user-select: none; }
    .gc button, .gc-pop button { font: inherit; color: inherit; }
    .gc-i { display: inline-grid; place-items: center; flex: none; }
    .gc[data-side="false"] { grid-template-columns: 0 minmax(0, 1fr); }
    .gc[data-side="false"] .gc-side { display: none; }
    .gc-ib { width: 40px; height: 40px; flex: none; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: none; color: var(--soft); cursor: pointer; }
    .gc-ib:hover { background: var(--hover); color: var(--text); }

    .gc-top { grid-column: 1 / -1; position: relative; display: flex; align-items: center; gap: 4px; padding: 0 16px 0 8px; }
    .gc-brand { display: flex; align-items: center; gap: 10px; margin: 0 36px 0 6px; font-size: 22px; color: var(--soft); }
    .gc-brand .gc-i { color: var(--accent); }
    .gc-today { height: 40px; margin-right: 12px; padding: 0 22px; border: 1px solid var(--muted); border-radius: 20px; background: none; font-weight: 500; cursor: pointer; }
    .gc-today:hover { background: var(--hover); }
    .gc-title { margin: 0 0 0 14px; font-size: 22px; font-weight: 400; white-space: nowrap; text-transform: capitalize; }
    .gc-grow { flex: 1; }
    .gc-status { margin-right: 8px; font-size: 13px; color: var(--muted); }
    .gc-status[data-failed="true"] { color: #f28b82; }
    .gc-views { height: 40px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px 0 18px; border: 1px solid var(--muted); border-radius: 20px; background: none; font-weight: 500; cursor: pointer; }
    .gc-views:hover { background: var(--hover); }
    .gc-menu { position: absolute; top: 54px; right: 16px; z-index: 40; min-width: 200px; padding: 8px 0; border-radius: 4px; background: var(--raised);
      box-shadow: 0 4px 8px 3px rgba(0, 0, 0, .15), 0 1px 3px rgba(0, 0, 0, .3); }
    .gc-menu button { width: 100%; height: 40px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border: 0; background: none; cursor: pointer; }
    .gc-menu button:hover, .gc-menu button[aria-checked="true"] { background: var(--hover); }
    .gc-menu kbd { font: inherit; color: var(--muted); }

    .gc-side { overflow-y: auto; padding: 8px 8px 24px 8px; }
    .gc-create { height: 56px; display: inline-flex; align-items: center; gap: 12px; margin: 8px 0 20px 8px; padding: 0 24px 0 16px; border: 0; border-radius: 16px;
      background: var(--raised); font-weight: 500; cursor: pointer; box-shadow: 0 1px 3px rgba(0, 0, 0, .3), 0 4px 8px 3px rgba(0, 0, 0, .15); }
    .gc-create:hover { background: #333537; }
    .gc-create .gc-i { color: var(--accent); }
    .gc-mini { padding: 0 8px 16px 16px; }
    .gc-mini-head { display: flex; align-items: center; margin-bottom: 4px; }
    .gc-mini-head b { flex: 1; font-weight: 500; text-transform: capitalize; }
    .gc-mini-head .gc-ib { width: 28px; height: 28px; }
    .gc-mini-grid { display: grid; grid-template-columns: repeat(7, 1fr); row-gap: 2px; text-align: center; }
    .gc-mini-grid span { font-size: 10.5px; line-height: 24px; color: var(--soft); text-transform: uppercase; }
    .gc-mday { width: 26px; height: 26px; margin: auto; padding: 0; border: 0; border-radius: 50%; background: none; font-size: 10.5px; cursor: pointer; }
    .gc-mday:hover { background: var(--hover); }
    .gc-mday[data-in="true"] { background: rgba(168, 199, 250, .12); }
    .gc-mday[data-out="true"] { color: var(--muted); }
    .gc-mday[data-focus="true"] { background: #004a77; color: #c2e7ff; }
    .gc-mday[data-today="true"] { background: var(--accent); color: var(--on-accent); font-weight: 600; }
    .gc-cals { margin-top: 8px; padding-left: 8px; }
    .gc-cals-head { width: 100%; height: 40px; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; border: 0; border-radius: 20px; background: none; font-weight: 500; cursor: pointer; }
    .gc-cals-head:hover { background: var(--hover); }
    .gc-cals-head[aria-expanded="false"] .gc-i { transform: rotate(-90deg); }
    .gc-cal { height: 32px; display: flex; align-items: center; gap: 14px; padding: 0 8px; border-radius: 4px; cursor: pointer; }
    .gc-cal:hover { background: var(--hover); }
    .gc-cal span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gc-cal input { appearance: none; width: 18px; height: 18px; flex: none; display: grid; place-items: center; margin: 0; border: 2px solid var(--c); border-radius: 2px; cursor: pointer; }
    .gc-cal input:checked { background: var(--c); }
    .gc-cal input:checked::after { content: ""; width: 4px; height: 9px; margin-top: -2px; border: solid #131314; border-width: 0 2px 2px 0; transform: rotate(45deg); }

    .gc-main { min-height: 0; display: flex; flex-direction: column; margin: 0 16px 16px 0; border-radius: 16px; background: #1b1b1c; overflow: hidden; }
    .gc[data-side="false"] .gc-main { margin-left: 16px; }
    .gc-message { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 14px; color: var(--soft); text-align: center; max-width: 420px; }
    .gc-message .gc-text-btn { border: 1px solid var(--muted); }

    .gc-time { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .gc-dayhead, .gc-allday { display: grid; overflow-y: hidden; scrollbar-gutter: stable; flex: none; }
    .gc-tz { align-self: end; padding: 0 8px 6px 0; font-size: 10px; color: var(--muted); text-align: right; }
    .gc-dh { display: flex; flex-direction: column; align-items: center; gap: 2px; padding-top: 10px; font-size: 11px; font-weight: 500; letter-spacing: .8px; color: var(--soft); text-transform: uppercase; }
    .gc-dnum { width: 46px; height: 46px; padding: 0; border: 0; border-radius: 50%; background: none; font-size: 26px !important; letter-spacing: 0; cursor: pointer; }
    .gc-dnum:hover { background: var(--hover); }
    .gc-dh[data-today="true"] { color: var(--accent); }
    .gc-dh[data-today="true"] .gc-dnum { background: var(--accent); color: var(--on-accent); }
    .gc-allday { grid-auto-rows: 24px; min-height: 28px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
    .gc-adcell { grid-row: 1 / -1; border-left: 1px solid var(--line); }
    .gc-bar { z-index: 1; height: 22px; margin: 1px 6px 1px 2px; padding: 0 8px; border-radius: 4px; background: var(--ebg); color: var(--efg);
      font-size: 12px; font-weight: 500; line-height: 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
    .gc-bar[data-open="true"], .gc-ev[data-open="true"], .gc-mitem[data-open="true"] { box-shadow: 0 0 0 2px var(--accent); }
    .gc-draft-bar { background: var(--accent); color: var(--on-accent); box-shadow: 0 6px 10px rgba(0, 0, 0, .4); }
    .gc-scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
    .gc-grid { position: relative; display: grid; }
    .gc-hours { position: relative; }
    .gc-hours span { position: absolute; right: 8px; transform: translateY(-50%); font-size: 10px; color: var(--muted); }
    .gc-col { position: relative; border-left: 1px solid var(--line); touch-action: none;
      background: repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px ${HOUR_H}px); }
    .gc-ev { position: absolute; z-index: 1; box-sizing: border-box; padding: 2px 8px; border: 1px solid #1b1b1c; border-radius: 6px; overflow: hidden;
      background: var(--ebg); color: var(--efg); font-size: 12px; line-height: 16px; cursor: pointer; }
    .gc-ev b { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gc-ev[data-short="true"] { display: flex; gap: 4px; padding-top: 0; line-height: 14px; }
    .gc-ev[data-short="true"] b { flex: 0 1 auto; }
    .gc-ev[data-short="true"] span { flex: none; }
    .gc-ev[data-past="true"] { filter: brightness(.82); }
    .gc-ev[data-dragging="true"] { z-index: 6; opacity: .92; box-shadow: 0 8px 16px rgba(0, 0, 0, .5); cursor: grabbing; }
    .gc-resize { position: absolute; left: 0; right: 0; bottom: 0; height: 7px; cursor: ns-resize; }
    .gc-draft { position: absolute; z-index: 5; left: 1px; right: 8px; box-sizing: border-box; padding: 2px 8px; border-radius: 6px; pointer-events: none;
      background: var(--accent); color: var(--on-accent); font-size: 12px; font-weight: 500; line-height: 16px; box-shadow: 0 6px 10px rgba(0, 0, 0, .4); overflow: hidden; }
    .gc-now { position: absolute; z-index: 4; left: -1px; right: 0; height: 2px; background: var(--red); pointer-events: none; }
    .gc-now::before { content: ""; position: absolute; left: -6px; top: -5px; width: 12px; height: 12px; border-radius: 50%; background: var(--red); }

    .gc-month { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .gc-mhead { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); flex: none; }
    .gc-mhead span { padding-top: 8px; border-left: 1px solid var(--line); font-size: 11px; font-weight: 500; color: var(--soft); text-align: center; text-transform: uppercase; }
    .gc-weeks { flex: 1; min-height: 0; display: grid; grid-auto-rows: minmax(0, 1fr); }
    .gc-week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); grid-auto-rows: 22px; border-bottom: 1px solid var(--line); overflow: hidden; }
    .gc-week:last-child { border-bottom: 0; }
    .gc-mcell { grid-row: 1 / -1; display: flex; justify-content: center; border-left: 1px solid var(--line); }
    .gc-mnum { height: 24px; min-width: 24px; margin-top: 4px; padding: 0 7px; border: 0; border-radius: 12px; background: none; font-size: 12px; font-weight: 500; cursor: pointer; }
    .gc-mnum:hover { background: var(--hover); }
    .gc-mcell[data-out="true"] .gc-mnum { color: var(--muted); }
    .gc-mcell[data-today="true"] .gc-mnum { background: var(--accent); color: var(--on-accent); }
    .gc-mitem { z-index: 1; height: 20px; display: flex; align-items: center; gap: 6px; margin: 1px 4px; padding: 0 6px; border-radius: 4px; font-size: 12px; white-space: nowrap; overflow: hidden; cursor: pointer; }
    .gc-mitem:hover, .gc-more:hover { background: var(--hover); }
    .gc-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--ebg); }
    .gc-mitem span { color: var(--soft); }
    .gc-mitem b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
    .gc-week .gc-bar { height: 20px; margin: 1px 4px; line-height: 20px; }
    .gc-more { z-index: 1; height: 20px; margin: 1px 4px; padding: 0 6px; border: 0; border-radius: 4px; background: none; font-size: 12px; font-weight: 500; text-align: left; cursor: pointer; }

    .gc-pop { position: fixed; z-index: 50; width: 448px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow-y: auto; border-radius: 8px;
      background: var(--raised); color: var(--text); user-select: text;
      box-shadow: 0 24px 38px 3px rgba(0, 0, 0, .14), 0 9px 46px 8px rgba(0, 0, 0, .12), 0 11px 15px -7px rgba(0, 0, 0, .2), 0 0 0 1px rgba(255, 255, 255, .04); }
    .gc-pop-tools { display: flex; justify-content: flex-end; gap: 2px; padding: 6px 6px 0; }
    .gc-pop-body { padding: 0 0 18px; }
    .gc-row { display: grid; grid-template-columns: 60px minmax(0, 1fr); align-items: start; padding: 5px 24px 5px 0; }
    .gc-row > :first-child { justify-self: center; margin-top: 2px; color: var(--soft); }
    .gc-swatch { width: 14px; height: 14px; margin-top: 8px !important; border-radius: 4px; background: var(--ebg); }
    .gc-pop-title { font-size: 22px; line-height: 28px; overflow-wrap: anywhere; }
    .gc-pop-when, .gc-muted { margin-top: 2px; color: var(--soft); }
    .gc-desc { max-height: 220px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
    .gc-title-in { box-sizing: border-box; width: 100%; padding: 6px 0; border: 0; border-bottom: 1px solid var(--muted); background: none; color: var(--text); font: inherit; font-size: 22px; outline: none; }
    .gc-title-in:focus { border-bottom: 2px solid var(--accent); padding-bottom: 5px; }
    .gc-in { box-sizing: border-box; height: 36px; padding: 0 10px; border: 0; border-radius: 4px; background: var(--field); color: var(--text); font: inherit; color-scheme: dark; outline: none; }
    .gc-in:focus { box-shadow: inset 0 -2px 0 var(--accent); }
    .gc-wide { width: 100%; }
    textarea.gc-in { height: 72px; padding: 8px 10px; resize: vertical; line-height: 1.4; }
    .gc-when-edit { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .gc-when-edit input[type="date"] { width: 140px; }
    .gc-when-edit input[type="time"] { width: 96px; }
    .gc-pop[data-all-day="true"] input[type="time"], .gc-pop[data-all-day="true"] .gc-dash-time { display: none; }
    .gc-check { display: inline-flex; align-items: center; gap: 10px; margin-top: 8px; cursor: pointer; }
    .gc-check input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
    .gc-pop select.gc-in { width: 100%; }
    .gc-pop-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 6px 16px 16px; }
    .gc-pop-foot .gc-failed { flex: 1; color: #f28b82; font-size: 13px; }
    .gc-save { height: 36px; padding: 0 24px; border: 0; border-radius: 18px; background: var(--accent); color: var(--on-accent) !important; font-weight: 500; cursor: pointer; }
    .gc-save:hover { box-shadow: 0 1px 3px rgba(0, 0, 0, .4); filter: brightness(1.05); }
    .gc-text-btn { height: 36px; padding: 0 16px; border: 0; border-radius: 18px; background: none; color: var(--accent) !important; font-weight: 500; cursor: pointer; }
    .gc-text-btn:hover { background: rgba(168, 199, 250, .08); }
    .gc-toast { position: fixed; left: 24px; bottom: 24px; z-index: 60; display: flex; align-items: center; gap: 18px; padding: 14px 16px; border-radius: 4px;
      background: #e3e3e3; color: #1f1f1f; font: 14px "Google Sans", Roboto, "Segoe UI", system-ui, sans-serif; box-shadow: 0 3px 5px -1px rgba(0, 0, 0, .2), 0 6px 10px rgba(0, 0, 0, .14); }
    .gc-toast:empty { display: none; }
    .gc-toast button { border: 0; background: none; color: #0b57d0; font: inherit; font-weight: 500; cursor: pointer; }`;

  /** The calendar's own id for the API: "primary" for the account's. */
  const enc = encodeURIComponent;
  /** "09:00" from a time. */
  const hhmm = (t) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return island.definePlugin({
    id: "google-calendar",
    label: "Google Calendar",
    description: "Your next events on the pill, the days ahead in a tab, and quick adding from Settings.",
    icon: `<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/><path d="M5.5 9h2v2h-2z"/>`,
    slots: ["glance", "tab"],
    // The service that signs it in, filed under this plugin's id.
    needs: ["oauth"],
    // Room for a week's hours and a month's grid: the island grows to it while this tab is shown.
    panelHeight: 340,
    // Drawn in Settings under the plugin's switch, in this order; options marked `inPanel` are
    // drawn by `settingsPanel` instead, which sits where the first of them is.
    options: {
      clientId: island.options.text("Client ID", "", "1234-abc.apps.googleusercontent.com", "From a Desktop app OAuth client in Google Cloud: see the README."),
      clientSecret: island.options.text("Client secret", "", "GOCSPX-…", "Google gives Desktop app clients one too; it isn't a password."),
      calendars: { ...island.options.list("Calendars", ["primary"]), inPanel: true },
      addTo: { ...island.options.text("Add events to", "primary"), inPanel: true },
      // Bumped by the settings card after it changes the calendar, so the island reads it again now.
      revision: { ...island.options.number("Revision", 0, { min: 0, max: Number.MAX_SAFE_INTEGER }), inPanel: true },
      view: island.options.choice(
        "Opens on",
        "week",
        [
          ["agenda", "List"],
          ["week", "Week"],
          ["month", "Month"],
        ],
        "The view the tab shows; switching it in the island changes this too.",
      ),
      // The calendar page's view, which the page itself switches.
      pageView: { ...island.options.choice("Calendar page", "week", [["day", "Day"], ["four", "4 days"], ["week", "Week"], ["month", "Month"]]), inPanel: true },
      days: island.options.number("Days ahead", 7, { min: 1, max: 14, unit: "days" }, "How far the list looks ahead."),
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
      const account = h("div");
      const calendars = h("div");
      const target = h("div");
      const adding = h("div");
      const result = h("div", { class: "gcal-result", role: "status" });
      root.append(h("style", {}, SETTINGS_CSS), h("div", { class: "gcal-settings" }, account, calendars, target, adding));

      /** The sign-in waiting for the browser; clicking again starts another, which replaces it. */
      let attempt = 0;
      let busy = false;
      let list = [];
      /** Asks the island to read the calendar again, now. */
      const nudge = () => host.setOptions({ revision: Date.now() });
      const fail = (where, e) => where.replaceChildren(h("span", { class: "failed" }, e instanceof SignedOut ? "Signed out: sign in again." : `Couldn't do it: ${e.message ?? e}`));

      /** The setup steps, while there is no client. */
      const setup = () => {
        account.replaceChildren(
          field(
            "Google account",
            "To sign in, this plugin needs your own Google OAuth client:",
            h(
              "ol",
              { class: "field-hint" },
              h("li", {}, "In Google Cloud Console, create a project and enable the Google Calendar API."),
              h("li", {}, "Set up the OAuth consent screen (External, Testing) and add yourself as a test user."),
              h("li", {}, "Create an OAuth client ID of type Desktop app."),
              h("li", {}, "Paste its client ID and secret above."),
            ),
            true,
          ),
        );
        for (const el of [calendars, target, adding]) el.replaceChildren();
      };

      /** Why the last sign-in failed, shown under the account's status. */
      let signInFailure = null;

      const draw = async () => {
        const o = host.options();
        if (!o.clientId) return setup();
        const signedIn = await oauth.signedIn(google(o));
        const status = busy ? "Waiting for the browser…" : signedIn ? "Signed in: your calendar is on the island." : "Not signed in.";
        const failure = signInFailure && !busy && !signedIn ? [h("div", { class: "failed" }, signInFailure)] : [];
        account.replaceChildren(
          field(
            "Google account",
            h("div", { class: "field-hint" }, status, ...failure),
            signedIn
              ? button("Sign out", () => void oauth.signOut(google(o)).then(() => (nudge(), draw())), { class: "secondary" })
              : button(busy ? "Sign in again" : "Sign in with Google", signIn, { class: "secondary" }),
          ),
        );
        if (!signedIn) {
          for (const el of [calendars, target, adding]) el.replaceChildren();
          return;
        }
        try {
          list = (await api(oauth, o, "/users/me/calendarList?fields=items(id,summary,backgroundColor,primary,accessRole)")).items ?? [];
        } catch (e) {
          const why = h("div", { class: "gcal-result" });
          calendars.replaceChildren(field("Calendars", null, why, true));
          return fail(why, e);
        }
        drawCalendars();
        drawAdding();
      };

      const signIn = async () => {
        const mine = ++attempt;
        busy = true;
        void draw();
        try {
          await oauth.signIn(google(host.options()));
          signInFailure = null;
          nudge();
        } catch (e) {
          // A newer sign-in replaced this one: it says how that went.
          if (mine !== attempt) return;
          signInFailure = `Couldn't sign in: ${e.message ?? e}`;
        }
        if (mine !== attempt) return;
        busy = false;
        void draw();
      };

      /** A checkbox per calendar; the account's own one stays "primary" in the options. */
      const drawCalendars = () => {
        const ids = host.options().calendars;
        const idOf = (c) => (c.primary ? "primary" : c.id);
        calendars.replaceChildren(
          field(
            "Calendars",
            "Shown on the pill and in its tab.",
            h(
              "div",
              { class: "gcal-calendars" },
              ...list.map((c) => {
                const box = h("input", { type: "checkbox" });
                box.checked = picked([c], ids).length > 0;
                box.addEventListener("change", () => {
                  const now = host.options().calendars.filter((id) => id !== idOf(c) && id !== c.id);
                  host.setOptions({ calendars: box.checked ? [...now, idOf(c)] : now });
                });
                return h("label", { class: "calendar", title: c.summary }, box, h("span", { class: "dot", style: `--dot: ${c.backgroundColor}` }), h("span", {}, c.summary));
              }),
            ),
            true,
          ),
        );
        const writable = list.filter((c) => c.accessRole === "owner" || c.accessRole === "writer");
        const idOfWritable = (c) => (c.primary ? "primary" : c.id);
        const pick = h(
          "select",
          { class: "gcal-control gcal-target", "aria-label": "Add events to" },
          ...writable.map((c) => h("option", { value: idOfWritable(c) }, c.summary)),
        );
        pick.value = writable.some((c) => idOfWritable(c) === host.options().addTo) ? host.options().addTo : "primary";
        pick.addEventListener("change", () => host.setOptions({ addTo: pick.value }));
        target.replaceChildren(field("Add events to", "The calendar new events go to.", pick));
      };

      /** What was just added, with a way to change it or take it back. */
      const added = (event, calendarId) => {
        const when = event.start?.dateTime ? `${dayMonth.format(Date.parse(event.start.dateTime))}, ${time.format(Date.parse(event.start.dateTime))}` : event.start?.date ?? "";
        result.replaceChildren(
          h("span", { class: "grow" }, `Added “${event.summary || "(No title)"}”${when ? `, ${when}` : ""}.`),
          button("Edit", () => host.openPage({ calendar: calendarId, event: event.id }), { class: "secondary" }),
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

      /** Adding by sentence (Google reads the date and time in it), or on the event page. */
      const drawAdding = () => {
        const sentence = h("input", { class: "gcal-control", type: "text", placeholder: "Lunch with Sam tomorrow at 1pm", "aria-label": "New event" });
        const quick = async () => {
          const text = sentence.value.trim();
          if (!text) return sentence.focus();
          const calendarId = host.options().addTo || "primary";
          try {
            const event = await api(oauth, host.options(), `/calendars/${enc(calendarId)}/events/quickAdd?text=${enc(text)}`, { method: "POST" });
            sentence.value = "";
            added(event, calendarId);
          } catch (e) {
            fail(result, e);
          }
        };
        sentence.addEventListener("keydown", (e) => e.key === "Enter" && void quick());
        adding.replaceChildren(
          field(
            "Add an event",
            "Type it the way you'd say it: Google reads the date and time.",
            [
              h("div", { class: "gcal-line" }, sentence, button("Add", () => void quick(), { class: "secondary" })),
              h("div", { class: "gcal-line gcal-or" }, h("span", {}, "Or pick a day and drag across its hours:"), button("Open the calendar…", () => host.openPage(), { class: "secondary" })),
              result,
            ],
            true,
          ),
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

    // The calendar, laid out like Google Calendar, in the whole Settings window (where typing
    // works): views by day, 4 days, week or month; drag across hours to create, drag an event to
    // move it or its bottom edge to resize it; click one for its details. Opened from the island
    // (on an event, or on hours dragged there) or from the card above.
    page(root, { oauth }, host) {
      const asked = host.params;
      host.setTitle("Calendar");
      const o = () => host.options();
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      let view = VIEWS[o().pageView] ? o().pageView : "week";
      let focus = asked.date ? localDate(asked.date) : startOfDay(Date.now());
      let mini = startOfMonth(focus);
      let calendars = [];
      let palette = {};
      let events = [];
      let read = "";
      let loaded = false;
      let problem = null;
      let syncing = false;
      let sideOpen = innerWidth >= 900;
      let menuOpen = false;
      let scroll = null;
      /** The event being created, before it's saved: its times (and whether it's all day). */
      let draft = null;
      /** The popup on screen, what it is about, and where it points. */
      let pop = null;
      let popFor = null;
      let alive = true;
      const collapsed = new Set();
      const gc = h("div", { class: "gc" });
      const toast = h("div", { class: "gc-toast", role: "status" });
      root.append(h("style", {}, GC_CSS), gc, toast);

      const trouble = (e) => (e instanceof SignedOut ? "You're signed out of Google." : String(e.message ?? e));
      const nudge = () => host.setOptions({ revision: Date.now() });
      let toastTimer;
      const say = (text, ...actions) => {
        clearTimeout(toastTimer);
        toast.replaceChildren(...(text ? [h("span", {}, text), ...actions] : []));
        if (text) toastTimer = setTimeout(() => toast.replaceChildren(), 8000);
      };
      const writable = () => calendars.filter((c) => c.accessRole === "owner" || c.accessRole === "writer");
      const idOf = (c) => (c.primary ? "primary" : c.id);
      const nameOf = (id) => calendars.find((c) => c.id === id || (c.primary && id === "primary"))?.summaryOverride ?? calendars.find((c) => c.id === id)?.summary ?? id;
      const iso = (t) => new Date(t).toISOString();

      // ---------- what is shown ----------

      /** The days on screen, [from, to) at local midnights. */
      const range = () => {
        if (view === "day") return [focus, addDays(focus, 1)];
        if (view === "four") return [focus, addDays(focus, 4)];
        if (view === "week") return [startOfWeek(focus), addDays(startOfWeek(focus), 7)];
        const from = startOfWeek(startOfMonth(focus));
        const next = new Date(new Date(focus).getFullYear(), new Date(focus).getMonth() + 1, 1).getTime();
        return [from, addDays(from, Math.ceil(Math.round((next - from) / DAY) / 7) * 7)];
      };
      const heading = () => {
        const [from, to] = range();
        const last = addDays(to, -1);
        if (view === "day") return longDate.format(focus);
        if (view === "month") return monthTitle.format(focus);
        const [a, b] = [new Date(from), new Date(last)];
        if (a.getMonth() === b.getMonth()) return monthTitle.format(from);
        if (a.getFullYear() === b.getFullYear()) return `${monthShort.format(from)} – ${monthShort.format(last)} ${yearOnly.format(from)}`;
        return `${monthShort.format(from)} ${yearOnly.format(from)} – ${monthShort.format(last)} ${yearOnly.format(last)}`;
      };

      const toEvent = (item, c) => {
        const allDay = !item.start.dateTime;
        const colors = palette[item.colorId];
        return {
          id: item.id,
          item,
          calendar: c.id,
          title: item.summary || "(No title)",
          allDay,
          start: allDay ? localDate(item.start.date) : Date.parse(item.start.dateTime),
          end: allDay ? localDate(item.end.date) : Date.parse(item.end.dateTime),
          bg: colors?.background ?? c.backgroundColor ?? "#a8c7fa",
          fg: colors?.foreground ?? c.foregroundColor ?? "#000",
          writable: c.accessRole === "owner" || c.accessRole === "writer",
          declined: (item.attendees ?? []).some((a) => a.self && a.responseStatus === "declined"),
        };
      };

      /** The events on screen, from the calendars ticked: read again when either changes, or after a change. */
      const load = async (force = false) => {
        const [from, to] = range();
        const shown = picked(calendars, o().calendars);
        const key = `${from}|${to}|${shown.map((c) => c.id).join(",")}`;
        if (!force && key === read) return;
        read = key;
        const query = new URLSearchParams({
          timeMin: iso(from),
          timeMax: iso(to),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "250",
          fields: "items(id,summary,location,description,colorId,recurringEventId,start,end,attendees(self,responseStatus))",
        });
        const each = await Promise.all(shown.map((c) => api(oauth, o(), `/calendars/${enc(c.id)}/events?${query}`).then((r) => (r.items ?? []).map((item) => toEvent(item, c)))));
        if (key !== read) return;
        events = each.flat().filter((e) => !(o().declined && e.declined));
        loaded = true;
        problem = null;
      };
      const refresh = async (force = false) => {
        syncing = true;
        draw();
        try {
          await load(force);
        } catch (e) {
          problem = trouble(e);
        }
        syncing = false;
        if (alive) draw();
      };

      // ---------- moving around ----------

      const show = (v) => {
        if (!VIEWS[v]) return;
        view = v;
        menuOpen = false;
        if (v !== o().pageView) host.setOptions({ pageView: v });
        closePop();
        void refresh();
      };
      const go = (day, v = view) => {
        focus = startOfDay(day);
        mini = startOfMonth(focus);
        scroll = null;
        if (v !== view) return show(v);
        closePop();
        void refresh();
      };
      const step = (n) => {
        if (view === "month") focus = new Date(new Date(focus).getFullYear(), new Date(focus).getMonth() + n, 1).getTime();
        else focus = addDays(focus, n * (view === "day" ? 1 : view === "four" ? 4 : 7));
        mini = startOfMonth(focus);
        closePop();
        void refresh();
      };

      // ---------- the frame ----------

      const top = () =>
        h(
          "header",
          { class: "gc-top" },
          iconButton("back", "Back to Settings", () => host.close()),
          iconButton("menu", "Main menu", () => {
            sideOpen = !sideOpen;
            draw();
          }),
          h("div", { class: "gc-brand" }, icon("calendar", 28), h("span", {}, "Calendar")),
          btn({ class: "gc-today", title: fullDay.format(Date.now()) }, "Today", () => go(Date.now())),
          iconButton("prev", "Previous", () => step(-1)),
          iconButton("next", "Next", () => step(1)),
          h("h2", { class: "gc-title" }, heading()),
          h("span", { class: "gc-grow" }),
          h("span", { class: "gc-status", "data-failed": String(Boolean(problem && loaded)) }, problem && loaded ? "Couldn't update" : syncing ? "Updating…" : ""),
          iconButton("refresh", "Refresh", () => void refresh(true)),
          btn({ class: "gc-views", "aria-haspopup": "menu", "aria-expanded": String(menuOpen) }, [VIEWS[view].label, icon("down", 18)], (e) => {
            e.stopPropagation();
            menuOpen = !menuOpen;
            draw();
          }),
          ...(menuOpen
            ? [
                h(
                  "div",
                  { class: "gc-menu", role: "menu" },
                  ...Object.entries(VIEWS).map(([v, { label, key }]) => btn({ role: "menuitemradio", "aria-checked": String(v === view) }, [h("span", {}, label), h("kbd", {}, key)], () => show(v))),
                ),
              ]
            : []),
        );

      const miniMonth = () => {
        const from = startOfWeek(mini);
        const [rf, rt] = range();
        const today = startOfDay(Date.now());
        const turn = (n) => {
          mini = new Date(new Date(mini).getFullYear(), new Date(mini).getMonth() + n, 1).getTime();
          draw();
        };
        return h(
          "section",
          { class: "gc-mini" },
          h("div", { class: "gc-mini-head" }, h("b", {}, monthTitle.format(mini)), iconButton("prev", "Previous month", () => turn(-1), 18), iconButton("next", "Next month", () => turn(1), 18)),
          h(
            "div",
            { class: "gc-mini-grid" },
            ...Array.from({ length: 7 }, (_, i) => h("span", {}, dayLetter.format(addDays(from, i)))),
            ...Array.from({ length: 42 }, (_, i) => {
              const d = addDays(from, i);
              return btn(
                {
                  class: "gc-mday",
                  "data-out": String(new Date(d).getMonth() !== new Date(mini).getMonth()),
                  "data-in": String(d >= rf && d < rt && view !== "month"),
                  "data-focus": String(d === focus),
                  "data-today": String(d === today),
                  "aria-label": fullDay.format(d),
                },
                dayNumber.format(d),
                () => go(d),
              );
            }),
          ),
        );
      };

      /** A list of calendars with their colored checkboxes: ticking one shows its events. */
      const calList = (title, list) => {
        if (!list.length) return [];
        const open = !collapsed.has(title);
        return [
          h(
            "section",
            { class: "gc-cals" },
            btn({ class: "gc-cals-head", "aria-expanded": String(open) }, [h("span", {}, title), icon("down", 18)], () => {
              if (open) collapsed.add(title);
              else collapsed.delete(title);
              draw();
            }),
            ...(open
              ? list.map((c) => {
                  const box = h("input", { type: "checkbox" });
                  box.checked = picked([c], o().calendars).length > 0;
                  box.addEventListener("change", () => {
                    const rest = o().calendars.filter((id) => id !== c.id && !(c.primary && id === "primary"));
                    host.setOptions({ calendars: box.checked ? [...rest, idOf(c)] : rest });
                    nudge();
                    void refresh();
                  });
                  return h("label", { class: "gc-cal", style: `--c: ${c.backgroundColor}`, title: c.summary }, box, h("span", {}, c.summaryOverride ?? c.summary));
                })
              : []),
          ),
        ];
      };

      const side = () =>
        h(
          "aside",
          { class: "gc-side" },
          btn({ class: "gc-create" }, [icon("plus", 26), "Create"], (e) => createAt(e.currentTarget)),
          miniMonth(),
          ...calList("My calendars", calendars.filter((c) => c.accessRole === "owner")),
          ...calList("Other calendars", calendars.filter((c) => c.accessRole !== "owner")),
        );

      const message = (text, ...actions) => h("div", { class: "gc-message" }, h("span", {}, text), ...(actions.length ? [h("div", {}, ...actions)] : []));

      const draw = () => {
        if (!alive) return;
        gc.dataset.side = String(sideOpen);
        const body = !loaded
          ? problem
            ? message(`Couldn't read your calendar: ${problem}`, btn({ class: "gc-text-btn" }, "Try again", () => void refresh(true)), btn({ class: "gc-text-btn" }, "Back to Settings", () => host.close()))
            : message("Loading your calendar…")
          : view === "month"
            ? monthView()
            : timeView();
        gc.replaceChildren(top(), side(), h("main", { class: "gc-main" }, body));
        placePop();
      };

      // ---------- day, 4 days and week ----------

      const timeView = () => {
        const [from, to] = range();
        const n = Math.round((to - from) / DAY);
        const days = Array.from({ length: n }, (_, i) => addDays(from, i));
        const today = startOfDay(Date.now());
        const columns = `var(--gutter) repeat(${n}, minmax(0, 1fr))`;
        const head = h(
          "div",
          { class: "gc-dayhead", style: `grid-template-columns: ${columns}` },
          h("div", { class: "gc-tz" }, zoneName),
          ...days.map((d) => h("div", { class: "gc-dh", "data-today": String(d === today) }, h("span", {}, dayShort.format(d)), btn({ class: "gc-dnum", title: fullDay.format(d) }, dayNumber.format(d), () => go(d, "day")))),
        );

        // The all-day row: events a day long or more, as bars across their days.
        const placed = stack(events.filter((e) => isBar(e) && e.start < to && e.end > from), from, n);
        const rows = Math.max(1, ...placed.map((p) => p.row + 1)) + (draft?.allDay ? 0 : 0);
        const allDay = h(
          "div",
          { class: "gc-allday", style: `grid-template-columns: ${columns}; grid-template-rows: repeat(${rows}, 24px)` },
          h("div", { style: `grid-row: 1 / span ${rows}` }),
          ...days.map((d, i) => {
            const cell = h("div", { class: "gc-adcell", style: `grid-column: ${i + 2}; grid-row: 1 / span ${rows}`, title: "Click to add an all-day event" });
            cell.addEventListener("click", () => createAllDay(d, cell));
            return cell;
          }),
          ...placed.map((p) => bar(p.e, `grid-column: ${p.c0 + 2} / ${p.c1 + 2}; grid-row: ${p.row + 1}`)),
          ...(draft?.allDay && draft.start < to && draft.end > from
            ? [h("div", { class: "gc-bar gc-draft-bar", style: `grid-column: ${Math.max(0, Math.round((draft.start - from) / DAY)) + 2} / span 1; grid-row: 1` }, draftTitle())]
            : []),
        );

        const hours = h(
          "div",
          { class: "gc-hours" },
          ...Array.from({ length: 23 }, (_, i) => h("span", { style: `top: ${(i + 1) * HOUR_H}px` }, hourLabel.format(today + (i + 1) * 3600_000))),
        );
        const grid = h("div", { class: "gc-grid", style: `grid-template-columns: ${columns}; height: ${24 * HOUR_H}px` }, hours, ...days.map(dayColumn));
        const scroller = h("div", { class: "gc-scroll" }, grid);
        scroller.addEventListener("scroll", () => {
          scroll = scroller.scrollTop;
          placePop();
        });
        const at =
          scroll ??
          Math.max(0, (draft && !draft.allDay ? (draft.start - startOfDay(draft.start)) / 3600_000 - 1 : days.includes(today) ? new Date().getHours() - 1.5 : 7.5) * HOUR_H);
        requestAnimationFrame(() => {
          scroller.scrollTop = at;
          placePop();
        });
        return h("div", { class: "gc-time" }, head, allDay, scroller);
      };

      const bar = (e, place) => {
        const b = h("div", { class: "gc-bar", style: `${place}; --ebg: ${e.bg}; --efg: ${e.fg}`, "data-id": e.id, "data-open": String(popFor?.event?.id === e.id), title: e.title }, e.title);
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openDetails(e);
        });
        return b;
      };

      const draftTitle = () => pop?.querySelector(".gc-title-in")?.value || "(No title)";

      /** A day's hours: its events where they fall, dragged across to create one. */
      const dayColumn = (d) => {
        const end = addDays(d, 1);
        const now = Date.now();
        const col = h("div", { class: "gc-col", "data-day": String(d) });
        const timed = events.filter((e) => !isBar(e) && onDay(e, d)).map((e) => ({ e, start: Math.max(e.start, d), end: Math.min(e.end, end) }));
        for (const x of lanes(timed)) col.append(block(x, d, now));
        if (draft && !draft.allDay && draft.start < end && draft.end > d) col.append(draftBlock(d));
        if (now >= d && now < end) col.append(h("div", { class: "gc-now", "data-day": String(d), style: `top: ${((now - d) / 3600_000) * HOUR_H}px` }));
        col.addEventListener("pointerdown", (ev) => drag(ev, col, d));
        return col;
      };

      const block = (x, d, now) => {
        const top = ((x.start - d) / 3600_000) * HOUR_H;
        const height = Math.max(18, ((x.end - x.start) / 3600_000) * HOUR_H - 1);
        const short = height < 38;
        const b = h(
          "div",
          {
            class: "gc-ev",
            style: `--ebg: ${x.e.bg}; --efg: ${x.e.fg}; top: ${top}px; height: ${height}px; left: calc(${(x.lane / x.of) * 100}% + 1px); width: calc(${100 / x.of}% - 8px)`,
            "data-id": x.e.id,
            "data-short": String(short),
            "data-past": String(x.e.end <= now),
            "data-open": String(popFor?.event?.id === x.e.id),
          },
          h("b", {}, x.e.title),
          h("span", {}, short ? time.format(x.e.start) : `${time.format(x.e.start)} – ${time.format(x.e.end)}`),
          ...(x.e.writable && x.end === x.e.end ? [h("i", { class: "gc-resize" })] : []),
        );
        b.addEventListener("pointerdown", (ev) => grab(ev, b, x.e));
        return b;
      };

      const draftBlock = (d) => {
        const s = Math.max(draft.start, d);
        const e = Math.min(draft.end, addDays(d, 1));
        return h(
          "div",
          { class: "gc-draft", style: `top: ${((s - d) / 3600_000) * HOUR_H}px; height: ${Math.max(18, ((e - s) / 3600_000) * HOUR_H - 1)}px` },
          `${draftTitle()}, ${time.format(draft.start)} – ${time.format(draft.end)}`,
        );
      };

      /** Minutes into the day at the pointer, in a column. */
      const minutesAt = (ev, col) => Math.min(24 * 60, Math.max(0, ((ev.clientY - col.getBoundingClientRect().top) / HOUR_H) * 60));

      /** Dragging across a column's hours marks a new event; a click marks one hour. */
      const drag = (ev, col, d) => {
        if (ev.button !== 0 || ev.target !== col) return;
        ev.preventDefault();
        if (pop) return closePop();
        const from = Math.min(24 * 60 - SNAP, Math.floor(minutesAt(ev, col) / SNAP) * SNAP);
        let moved = false;
        draft = { allDay: false, start: d + from * MINUTE, end: d + (from + SNAP) * MINUTE };
        let shown = draftBlock(d);
        col.append(shown);
        col.setPointerCapture(ev.pointerId);
        const move = (m) => {
          const to = Math.round(minutesAt(m, col) / SNAP) * SNAP;
          if (!moved && Math.abs(to - from) < SNAP) return;
          moved = true;
          const [a, b] = to > from ? [from, Math.max(to, from + SNAP)] : [to, from + SNAP];
          draft = { allDay: false, start: d + a * MINUTE, end: d + b * MINUTE };
          const next = draftBlock(d);
          shown.replaceWith(next);
          shown = next;
        };
        const up = () => {
          col.removeEventListener("pointermove", move);
          col.removeEventListener("pointerup", up);
          col.removeEventListener("pointercancel", up);
          if (!moved) draft = { allDay: false, start: d + from * MINUTE, end: d + Math.min(24 * 60, from + 60) * MINUTE };
          const next = draftBlock(d);
          shown.replaceWith(next);
          openEditor({ draft });
        };
        col.addEventListener("pointermove", move);
        col.addEventListener("pointerup", up);
        col.addEventListener("pointercancel", up);
      };

      /** An event: a click opens it; dragging moves it (to another day too), its bottom edge resizes it. */
      const grab = (ev, b, e) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        ev.preventDefault();
        const resizing = ev.target.classList.contains("gc-resize");
        const sx = ev.clientX;
        const sy = ev.clientY;
        const cols = [...gc.querySelectorAll(".gc-col")];
        const rects = cols.map((c) => c.getBoundingClientRect());
        const startDay = startOfDay(e.start);
        let moved = false;
        let ns = e.start;
        let ne = e.end;
        // Followed on the document: moving the block to another day's column would lose a capture.
        const move = (m) => {
          if (!e.writable) return;
          if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
          if (!moved) closePop();
          moved = true;
          b.dataset.dragging = "true";
          const dm = Math.round(((m.clientY - sy) / HOUR_H) * 60 / SNAP) * SNAP * MINUTE;
          let target = b.parentElement;
          if (resizing) ne = Math.max(e.start + SNAP * MINUTE, e.end + dm);
          else {
            const i = rects.findIndex((r) => m.clientX >= r.left && m.clientX < r.right);
            if (i >= 0) target = cols[i];
            const day = Number(target.dataset.day);
            ns = day + (e.start - startDay) + dm;
            ne = ns + (e.end - e.start);
          }
          if (target !== b.parentElement) target.append(b);
          const day = Number(target.dataset.day);
          b.style.top = `${((Math.max(ns, day) - day) / 3600_000) * HOUR_H}px`;
          b.style.height = `${Math.max(18, ((Math.min(ne, addDays(day, 1)) - Math.max(ns, day)) / 3600_000) * HOUR_H - 1)}px`;
          b.style.left = "1px";
          b.style.width = "calc(100% - 8px)";
          const label = b.querySelector("span");
          if (label) label.textContent = `${time.format(ns)} – ${time.format(ne)}`;
        };
        const up = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          document.removeEventListener("pointercancel", up);
          if (!moved) return openDetails(e);
          delete b.dataset.dragging;
          if (ns === e.start && ne === e.end) return draw();
          void retime(e, ns, ne);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", up);
      };

      /** Moves an event to new times: at once on screen, then at Google; undone if Google refuses. */
      const retime = async (e, ns, ne, undoable = true) => {
        const was = [e.start, e.end];
        e.start = ns;
        e.end = ne;
        draw();
        try {
          await api(oauth, o(), `/calendars/${enc(e.calendar)}/events/${enc(e.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ start: { dateTime: iso(ns), timeZone: zone, date: null }, end: { dateTime: iso(ne), timeZone: zone, date: null } }),
          });
          nudge();
          if (undoable) say(`“${e.title}” moved to ${time.format(ns)}`, btn({}, "Undo", () => (say(""), void retime(e, was[0], was[1], false))));
        } catch (err) {
          [e.start, e.end] = was;
          draw();
          say(`Couldn't move it: ${trouble(err)}`);
        }
      };

      // ---------- month ----------

      const monthView = () => {
        const [from, to] = range();
        const weeks = Math.round((to - from) / DAY / 7);
        const today = startOfDay(Date.now());
        const inMonth = new Date(focus).getMonth();
        const height = gc.querySelector(".gc-main")?.clientHeight || innerHeight - 96;
        /** Rows of events a day has room for, under its number and above "+n more". */
        const fits = Math.max(1, Math.floor(((height - 28) / weeks - 30) / 22) - 1);
        return h(
          "div",
          { class: "gc-month" },
          h("div", { class: "gc-mhead" }, ...Array.from({ length: 7 }, (_, i) => h("span", {}, dayShort.format(addDays(from, i))))),
          h(
            "div",
            { class: "gc-weeks" },
            ...Array.from({ length: weeks }, (_, w) => {
              const start = addDays(from, w * 7);
              const week = h("div", { class: "gc-week", style: `grid-template-rows: 30px repeat(${fits}, 22px) 22px` });
              const used = Array.from({ length: 7 }, () => new Set());
              const hidden = Array(7).fill(0);
              const items = [];
              for (const p of stack(events.filter((e) => isBar(e) && e.start < addDays(start, 7) && e.end > start), start, 7)) {
                if (p.row < fits) {
                  items.push(bar(p.e, `grid-column: ${p.c0 + 1} / ${p.c1 + 1}; grid-row: ${p.row + 2}`));
                  for (let c = p.c0; c < p.c1; c++) used[c].add(p.row);
                } else for (let c = p.c0; c < p.c1; c++) hidden[c]++;
              }
              for (let i = 0; i < 7; i++) {
                const d = addDays(start, i);
                for (const e of events.filter((x) => !isBar(x) && onDay(x, d))) {
                  let r = 0;
                  while (used[i].has(r)) r++;
                  if (r >= fits) {
                    hidden[i]++;
                    continue;
                  }
                  used[i].add(r);
                  const item = h(
                    "div",
                    { class: "gc-mitem", style: `grid-column: ${i + 1}; grid-row: ${r + 2}; --ebg: ${e.bg}`, "data-id": e.id, "data-open": String(popFor?.event?.id === e.id), title: `${time.format(e.start)} ${e.title}` },
                    h("i", { class: "gc-dot" }),
                    h("span", {}, time.format(e.start)),
                    h("b", {}, e.title),
                  );
                  item.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    openDetails(e);
                  });
                  items.push(item);
                }
                if (hidden[i]) items.push(btn({ class: "gc-more", style: `grid-column: ${i + 1}; grid-row: ${fits + 2}` }, `${hidden[i]} more`, () => go(d, "day")));
              }
              const cells = Array.from({ length: 7 }, (_, i) => {
                const d = addDays(start, i);
                const first = new Date(d).getDate() === 1;
                const cell = h(
                  "div",
                  { class: "gc-mcell", style: `grid-column: ${i + 1}`, "data-out": String(new Date(d).getMonth() !== inMonth), "data-today": String(d === today) },
                  btn({ class: "gc-mnum", title: fullDay.format(d) }, first ? dayAndMonth.format(d) : dayNumber.format(d), (ev) => {
                    ev.stopPropagation();
                    go(d, "day");
                  }),
                );
                cell.addEventListener("click", () => createAllDay(d, cell));
                return cell;
              });
              const drafted =
                draft && draft.start < addDays(start, 7) && draft.end > start
                  ? [h("div", { class: "gc-bar gc-draft-bar", style: `grid-column: ${Math.round((startOfDay(draft.start) - start) / DAY) + 1}; grid-row: 2` }, draftTitle())]
                  : [];
              week.append(...cells, ...items, ...drafted);
              return week;
            }),
          ),
        );
      };

      // ---------- creating ----------

      /** "Create" (or C): a new hour on the day in view, at the next hour when it's today. */
      const createAt = (from) => {
        const today = startOfDay(Date.now());
        const [rf, rt] = range();
        const day = today >= rf && today < rt ? today : view === "month" ? focus : rf;
        const start = day === today ? new Date(Date.now() + 60 * MINUTE).setMinutes(0, 0, 0) : day + 9 * 60 * MINUTE;
        draft = { allDay: false, start, end: start + 60 * MINUTE };
        scroll = null;
        draw();
        openEditor({ draft }, view === "month" ? from : null);
      };
      const createAllDay = (d, cell) => {
        if (pop) return closePop();
        draft = { allDay: true, start: d, end: addDays(d, 1) };
        draw();
        openEditor({ draft }, cell);
      };

      // ---------- popups ----------

      /** Beside what it's about (the new event, an event, a day), inside the window. */
      const placePop = () => {
        if (!pop || !popFor) return;
        const anchor = popFor.anchor?.() ?? null;
        const r = anchor?.getBoundingClientRect() ?? { left: innerWidth / 2 - 224, right: innerWidth / 2 + 224, top: innerHeight / 4 };
        const w = pop.offsetWidth;
        const tall = pop.offsetHeight;
        let left = r.right + 12;
        if (left + w > innerWidth - 12) left = r.left - w - 12;
        if (left < 12) left = Math.max(12, Math.min(innerWidth - w - 12, r.left));
        pop.style.left = `${left}px`;
        pop.style.top = `${Math.min(Math.max(12, r.top), Math.max(12, innerHeight - tall - 12))}px`;
      };

      const closePop = () => {
        const had = Boolean(pop || draft);
        pop?.remove();
        pop = null;
        popFor = null;
        draft = null;
        if (had) draw();
      };

      const showPop = (el, about) => {
        pop?.remove();
        pop = el;
        popFor = about;
        root.append(el);
        // Drawn first, so what it is about shows as chosen; then placed beside it.
        draw();
      };

      const anchorOf = (e) => () => [...gc.querySelectorAll("[data-id]")].find((el) => el.dataset.id === e.id) ?? null;

      /** An event's details: when, where, what, which calendar; edit and delete when it can be changed. */
      const openDetails = (e) => {
        draft = null;
        const row = (lead, ...rest) => h("div", { class: "gc-row" }, lead, h("div", {}, ...rest));
        const el = h(
          "div",
          { class: "gc-pop", role: "dialog", "aria-label": e.title },
          h(
            "div",
            { class: "gc-pop-tools" },
            ...(e.writable ? [iconButton("edit", "Edit event", () => openEditor({ event: e })), iconButton("trash", "Delete event", () => void remove(e))] : []),
            iconButton("close", "Close", closePop),
          ),
          h(
            "div",
            { class: "gc-pop-body" },
            row(h("i", { class: "gc-swatch", style: `--ebg: ${e.bg}` }), h("div", { class: "gc-pop-title" }, e.title), h("div", { class: "gc-pop-when" }, whenText(e)), ...(e.item.recurringEventId ? [h("div", { class: "gc-muted" }, "Repeats")] : [])),
            ...(e.item.location ? [row(icon("place"), e.item.location)] : []),
            ...(e.item.description ? [row(icon("notes"), h("div", { class: "gc-desc" }, plain(e.item.description)))] : []),
            row(icon("calendar"), nameOf(e.calendar), ...(e.writable ? [] : [h("div", { class: "gc-muted" }, "You can only view this calendar.")])),
          ),
        );
        showPop(el, { kind: "details", event: e, anchor: anchorOf(e) });
      };

      /** Creating (from `draft`) or changing (`event`) an event: title, when, where, what, which calendar. */
      const openEditor = ({ draft: fresh, event }, anchorEl = null) => {
        const isNew = !event;
        const start0 = isNew ? fresh.start : event.start;
        const end0 = isNew ? (fresh.allDay ? addDays(fresh.end, -1) : fresh.end) : event.allDay ? addDays(event.end, -1) : event.end;
        let allDay = isNew ? fresh.allDay : event.allDay;
        const title = h("input", { class: "gc-title-in", type: "text", placeholder: "Add title", "aria-label": "Title", value: event?.item.summary ?? "" });
        const startDate = h("input", { class: "gc-in", type: "date", value: isoDate(start0), "aria-label": "Start date" });
        const startTime = h("input", { class: "gc-in", type: "time", step: "900", value: hhmm(start0), "aria-label": "Start time" });
        const endTime = h("input", { class: "gc-in", type: "time", step: "900", value: hhmm(end0), "aria-label": "End time" });
        const endDate = h("input", { class: "gc-in", type: "date", value: isoDate(end0), "aria-label": "End date" });
        const allDayBox = h("input", { type: "checkbox" });
        allDayBox.checked = allDay;
        const where = h("input", { class: "gc-in gc-wide", type: "text", placeholder: "Add location", "aria-label": "Location", value: event?.item.location ?? "" });
        const notes = h("textarea", { class: "gc-in gc-wide", placeholder: "Add description", "aria-label": "Description" });
        notes.value = event?.item.description ? plain(event.item.description) : "";
        const mine = event ? writable().find((c) => c.id === event.calendar) : null;
        const calendar = h("select", { class: "gc-in", "aria-label": "Calendar" }, ...writable().map((c) => h("option", { value: idOf(c) }, c.summaryOverride ?? c.summary)));
        calendar.value = mine ? idOf(mine) : writable().some((c) => idOf(c) === o().addTo) ? o().addTo : "primary";
        const failed = h("span", { class: "gc-failed", role: "status" });

        const at = (date, t) => new Date(`${date.value}T${allDay ? "00:00" : t.value || "00:00"}`).getTime();
        let length = end0 - start0;
        /** A new event's block follows its times; the day it's on is shown. */
        const follow = () => {
          if (!isNew || !draft) return;
          const s = at(startDate, startTime);
          const e = allDay ? addDays(at(endDate, endTime), 1) : at(endDate, endTime);
          draft = { allDay, start: s, end: Math.max(e, s + SNAP * MINUTE) };
          const [rf, rt] = range();
          if (startOfDay(s) < rf || startOfDay(s) >= rt) {
            focus = startOfDay(s);
            mini = startOfMonth(focus);
            scroll = null;
            void refresh();
          } else draw();
        };
        const followStart = () => {
          const to = at(startDate, startTime) + Math.max(0, length);
          endDate.value = isoDate(to);
          endTime.value = hhmm(to);
          follow();
        };
        startDate.addEventListener("change", followStart);
        startTime.addEventListener("change", followStart);
        for (const el of [endDate, endTime])
          el.addEventListener("change", () => {
            length = at(endDate, endTime) - at(startDate, startTime);
            follow();
          });
        title.addEventListener("input", () => {
          const label = gc.querySelector(".gc-draft, .gc-draft-bar");
          if (label && draft) label.textContent = draft.allDay ? draftTitle() : `${draftTitle()}, ${time.format(draft.start)} – ${time.format(draft.end)}`;
        });

        const row = (lead, ...rest) => h("div", { class: "gc-row" }, lead, h("div", {}, ...rest));
        const form = h(
          "form",
          { class: "gc-pop", role: "dialog", "aria-label": isNew ? "New event" : "Edit event", "data-all-day": String(allDay) },
          h("div", { class: "gc-pop-tools" }, iconButton("close", "Close", closePop)),
          h(
            "div",
            { class: "gc-pop-body" },
            row(h("span"), title),
            row(
              icon("clock"),
              h("div", { class: "gc-when-edit" }, startDate, startTime, h("span", { class: "gc-dash-time" }, "–"), endTime, endDate),
              h("label", { class: "gc-check" }, allDayBox, "All day"),
            ),
            row(icon("place"), where),
            row(icon("notes"), notes),
            row(icon("calendar"), calendar),
            ...(event?.item.recurringEventId ? [row(icon("repeat"), h("div", { class: "gc-muted" }, "One occurrence of a repeating event: changes apply to it alone."))] : []),
          ),
          h("div", { class: "gc-pop-foot" }, failed, ...(isNew ? [] : [btn({ class: "gc-text-btn" }, "Cancel", () => openDetails(event))]), h("button", { type: "submit", class: "gc-save" }, "Save")),
        );
        allDayBox.addEventListener("change", () => {
          allDay = allDayBox.checked;
          form.dataset.allDay = String(allDay);
          length = at(endDate, endTime) - at(startDate, startTime);
          follow();
        });

        let saving = false;
        form.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          if (saving) return;
          const s = at(startDate, startTime);
          const e = at(endDate, endTime);
          if (!startDate.value || !endDate.value || (allDay ? e < s : e <= s)) return void (failed.textContent = "It has to end after it starts.");
          saving = true;
          failed.textContent = "";
          const when = allDay
            ? { start: { date: startDate.value, dateTime: null, timeZone: null }, end: { date: isoDate(addDays(localDate(endDate.value), 1)), dateTime: null, timeZone: null } }
            : { start: { dateTime: iso(s), timeZone: zone, date: null }, end: { dateTime: iso(e), timeZone: zone, date: null } };
          const fields = { summary: title.value.trim(), location: where.value.trim(), description: notes.value, ...when };
          const to = calendar.value;
          try {
            let saved;
            if (isNew) {
              const { start, end, ...rest } = fields;
              const clean = (x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== null));
              saved = await api(oauth, o(), `/calendars/${enc(to)}/events`, { method: "POST", body: JSON.stringify({ ...rest, start: clean(start), end: clean(end) }) });
            } else {
              saved = await api(oauth, o(), `/calendars/${enc(event.calendar)}/events/${enc(event.id)}`, { method: "PATCH", body: JSON.stringify(fields) });
              if (mine && to !== idOf(mine)) saved = await api(oauth, o(), `/calendars/${enc(event.calendar)}/events/${enc(event.id)}/move?destination=${enc(to)}`, { method: "POST" });
            }
            closePop();
            nudge();
            const name = saved?.summary || "(No title)";
            say(
              isNew ? `“${name}” saved` : `“${name}” updated`,
              ...(isNew && saved?.id
                ? [
                    btn({}, "Undo", async () => {
                      say("");
                      await api(oauth, o(), `/calendars/${enc(to)}/events/${enc(saved.id)}`, { method: "DELETE" }).catch((err) => say(`Not undone: ${trouble(err)}`));
                      nudge();
                      void refresh(true);
                    }),
                  ]
                : []),
            );
            void refresh(true);
          } catch (err) {
            saving = false;
            failed.textContent = `Not saved: ${trouble(err)}`;
          }
        });

        const anchor = isNew ? () => anchorEl ?? gc.querySelector(".gc-draft, .gc-draft-bar") : anchorOf(event);
        showPop(form, { kind: "editor", event, anchor });
        title.focus();
      };

      /** Deletes at once, as Google Calendar does, with a way to bring it back. */
      const remove = async (e) => {
        try {
          await api(oauth, o(), `/calendars/${enc(e.calendar)}/events/${enc(e.id)}`, { method: "DELETE" });
        } catch (err) {
          return say(`Couldn't delete it: ${trouble(err)}`);
        }
        events = events.filter((x) => x !== e);
        closePop();
        draw();
        nudge();
        // A repeating event's occurrence can't be brought back as itself: no Undo for those.
        const back = ({ summary, location, description, colorId, start, end }) => ({ summary, location, description, colorId, start, end });
        say(
          `“${e.title}” deleted`,
          ...(e.item.recurringEventId
            ? []
            : [
                btn({}, "Undo", async () => {
                  say("");
                  await api(oauth, o(), `/calendars/${enc(e.calendar)}/events`, { method: "POST", body: JSON.stringify(back(e.item)) }).catch((err) => say(`Not undone: ${trouble(err)}`));
                  nudge();
                  void refresh(true);
                }),
              ]),
        );
        void refresh(true);
      };

      // ---------- keys, as in Google Calendar ----------

      const keys = (ev) => {
        if (ev.key === "Escape") {
          if (menuOpen) {
            menuOpen = false;
            draw();
          } else closePop();
          return;
        }
        const typing = ev.target instanceof HTMLElement && ev.target.closest("input, textarea, select, [contenteditable]");
        if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const k = ev.key.toLowerCase();
        if ((k === "delete" || k === "backspace") && popFor?.kind === "details" && popFor.event.writable) return void remove(popFor.event);
        const act = { t: () => go(Date.now()), d: () => show("day"), x: () => show("four"), w: () => show("week"), m: () => show("month"), j: () => step(1), n: () => step(1), k: () => step(-1), p: () => step(-1), c: () => createAt(gc.querySelector(".gc-create")) }[k];
        if (act) {
          ev.preventDefault();
          act();
        }
      };
      const away = (ev) => {
        if (menuOpen && !ev.target.closest?.(".gc-menu, .gc-views")) {
          menuOpen = false;
          draw();
        }
      };
      let resizing;
      const resized = () => {
        clearTimeout(resizing);
        resizing = setTimeout(draw, 80);
      };
      document.addEventListener("keydown", keys);
      document.addEventListener("pointerdown", away);
      addEventListener("resize", resized);
      // The red line moves with the time; a new day redraws.
      let today = startOfDay(Date.now());
      const clock = setInterval(() => {
        const now = Date.now();
        if (startOfDay(now) !== today) {
          today = startOfDay(now);
          return draw();
        }
        for (const line of gc.querySelectorAll(".gc-now")) line.style.top = `${((now - Number(line.dataset.day)) / 3600_000) * HOUR_H}px`;
      }, 30_000);

      // ---------- start ----------

      draw();
      (async () => {
        try {
          const [list, colors] = await Promise.all([
            api(oauth, o(), "/users/me/calendarList?fields=items(id,summary,summaryOverride,backgroundColor,foregroundColor,primary,accessRole)"),
            api(oauth, o(), "/colors").catch(() => ({})),
          ]);
          const rank = (c) => (c.primary ? 0 : c.accessRole === "owner" ? 1 : 2);
          calendars = (list.items ?? []).sort((a, b) => rank(a) - rank(b) || String(a.summary).localeCompare(String(b.summary)));
          palette = colors.event ?? {};
          // Opened on an event (from the island): its day, with its details open.
          let opening = null;
          if (asked.calendar && asked.event) {
            const item = await api(oauth, o(), `/calendars/${enc(asked.calendar)}/events/${enc(asked.event)}`);
            focus = startOfDay(item.start?.dateTime ? Date.parse(item.start.dateTime) : localDate(item.start.date));
            mini = startOfMonth(focus);
            opening = asked.event;
          }
          // Opened on hours dragged in the island: marked, with the editor open.
          const minutes = (t) => {
            const [, hh, mm] = /^(\d{1,2}):(\d{2})$/.exec(t ?? "") ?? [];
            return hh === undefined ? null : Math.min(24 * 60, Number(hh) * 60 + Number(mm));
          };
          const a = minutes(asked.start ?? asked.time);
          if (a !== null) {
            if (view === "month") view = "week";
            draft = { allDay: false, start: focus + a * MINUTE, end: focus + Math.max(a + SNAP, minutes(asked.end) ?? a + 60) * MINUTE };
          }
          await load();
          if (!alive) return;
          draw();
          const found = opening && events.find((e) => e.id === opening);
          if (found) openDetails(found);
          else if (draft) openEditor({ draft });
        } catch (e) {
          problem = trouble(e);
          draw();
        }
      })();

      return () => {
        alive = false;
        pop?.remove();
        clearInterval(clock);
        clearTimeout(toastTimer);
        document.removeEventListener("keydown", keys);
        document.removeEventListener("pointerdown", away);
        removeEventListener("resize", resized);
      };
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

      /** The day the views start from; ‹ and › move it, Today brings it back. */
      let anchor = Date.now();

      /** The days the view shows, [from, to) at local midnights. */
      const shownRange = (o) => {
        if (o.view === "week") return [startOfWeek(anchor), addDays(startOfWeek(anchor), 7)];
        if (o.view === "month") {
          const from = startOfWeek(startOfMonth(anchor));
          return [from, addDays(from, 42)];
        }
        return [startOfDay(anchor), addDays(startOfDay(anchor), o.days)];
      };
      /** What a sync reads: the view's days, and always today onwards for the pill. */
      const wanted = (o) => {
        const [from, to] = shownRange(o);
        const today = startOfDay(Date.now());
        return [Math.min(from, today), Math.max(to, addDays(today, o.days))];
      };

      /** What a sync depends on: a change reads the calendar again at once. */
      const signature = (o) => [o.clientId, o.clientSecret, o.calendars.join(","), o.declined, o.revision, ...wanted(o)].join("|");

      const sync = async () => {
        const o = host.options();
        syncing = true;
        synced = signature(o);
        try {
          if (!o.clientId) throw Object.assign(new Error("setup"), { setup: true });
          const list = (await api(oauth, o, "/users/me/calendarList?fields=items(id,backgroundColor,primary)")).items ?? [];
          const [from, to] = wanted(o);
          const query = new URLSearchParams({
            timeMin: new Date(from).toISOString(),
            timeMax: new Date(to).toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "250",
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

      // The tab: a toolbar (the view, moving through time, refreshing and adding), then the view.
      const root = h("div", { class: "gcal" });
      const bar = h("i");
      /** Where the week's grid was scrolled, kept across redraws; null scrolls to the morning. */
      let scrolled = null;

      /** A message in place of the calendar, with what to do about it. */
      const empty = (text, ...actions) => root.replaceChildren(h("div", { class: "gcal-empty" }, h("span", {}, text), ...(actions.length ? [h("div", {}, ...actions)] : [])));

      let attempt = 0;
      const signIn = async () => {
        const mine = ++attempt;
        empty("Waiting for the browser…", button("Sign in again", () => void signIn()));
        try {
          await oauth.signIn(google(host.options()));
          await sync();
        } catch (e) {
          // A newer sign-in replaced this one: it says how that went.
          if (mine !== attempt) return;
          empty(`Not signed in: ${e.message ?? e}`, button("Try again", () => void signIn(), { class: "primary" }));
        }
      };

      /** Redraws now: after a click, rather than at the next second. */
      const redraw = () => {
        drawn = "";
        host.refresh();
      };
      const show = (view, at = anchor) => {
        anchor = at;
        scrolled = null;
        if (view !== host.options().view) host.setOptions({ view });
        redraw();
      };
      const move = (step) => {
        const view = host.options().view;
        const d = new Date(anchor);
        if (view === "month") anchor = new Date(d.getFullYear(), d.getMonth() + step, 1).getTime();
        else anchor = addDays(anchor, step * (view === "week" ? 7 : host.options().days));
        scrolled = null;
        redraw();
      };

      /** "October 2026", "13 – 19 Oct" (or "27 Oct – 2 Nov"), or the list's first day. */
      const title = (view, now) => {
        if (view === "month") return monthTitle.format(anchor);
        if (view === "week") {
          const from = startOfWeek(anchor);
          const to = addDays(from, 6);
          return `${new Date(from).getMonth() === new Date(to).getMonth() ? dayNumber.format(from) : dayAndMonth.format(from)} – ${dayAndMonth.format(to)}`;
        }
        return dayLabel(startOfDay(anchor), now);
      };

      const toolbar = (view, now) => {
        const [from, to] = shownRange({ ...host.options(), view });
        const away = view === "month" ? startOfMonth(anchor) !== startOfMonth(now) : view === "week" ? !(from <= now && now < to) : startOfDay(anchor) !== startOfDay(now);
        return h(
          "div",
          { class: "gcal-top" },
          h(
            "div",
            { class: "gcal-views" },
            ...[
              ["agenda", "List"],
              ["week", "Week"],
              ["month", "Month"],
            ].map(([v, label]) => button(label, () => show(v), { "aria-pressed": String(v === view) })),
          ),
          button("‹", () => move(-1), { class: "gcal-nav", "aria-label": "Earlier", title: "Earlier" }),
          button("›", () => move(1), { class: "gcal-nav", "aria-label": "Later", title: "Later" }),
          // Only once away from today: a way back.
          ...(away ? [button("Today", () => show(view, Date.now()))] : []),
          h(
            "span",
            { class: "gcal-range" },
            title(view, now),
            ...(problem ? [h("small", { "data-failed": "true", title: problem }, "couldn't update")] : []),
          ),
          button(syncing ? "…" : "↻", () => void sync(), { class: "gcal-nav", "aria-label": "Refresh", title: `Refresh (updated ${time.format(fetchedAt)})` }),
          button("+", () => host.openPage({ date: isoDate(Math.max(startOfDay(anchor), view === "agenda" ? 0 : from)) }), { class: "gcal-nav primary", "aria-label": "Add an event", title: "Add an event" }),
        );
      };

      /** Opens an event on the page, to change or remove it. */
      const edit = (e) => (ev) => {
        ev?.stopPropagation();
        host.openPage({ calendar: e.calendar, event: e.id });
      };

      /** What's on now or next, and the days from the anchor on. */
      const agenda = (now) => {
        const { current, next } = around(now);
        const shown = current ?? next;
        const focus = h(
          "div",
          { class: "gcal-focus", style: shown ? `--event: ${shown.color}` : "", ...(shown ? { "data-open": "true", title: "Edit" } : {}) },
          h("div", { class: "gcal-kicker" }, current ? "Now" : next ? (startOfDay(next.start) === startOfDay(now) ? "Next" : dayLabel(next.start, now)) : "Free"),
          h("div", { class: "gcal-title" }, shown ? shown.title : "Nothing else planned"),
          h("div", { class: "gcal-when" }, shown ? `${time.format(shown.start)} – ${time.format(shown.end)}` : ""),
          ...(current ? [h("div", { class: "gcal-bar" }, bar)] : []),
        );
        if (shown) focus.addEventListener("click", edit(shown));
        const [from, to] = shownRange(host.options());
        const list = h("div", { class: "gcal-list" });
        let day = -1;
        for (const e of events.filter((e) => e.end > Math.max(from, startOfDay(now)) && e.start < to)) {
          const d = Math.max(startOfDay(e.start), from, startOfDay(now));
          if (d !== day) {
            day = d;
            list.append(h("div", { class: "gcal-day" }, dayLabel(d, now)));
          }
          const row = h(
            "div",
            { class: "gcal-row", style: `--event: ${e.color}`, "data-now": String(e === current), "data-past": String(!e.allDay && e.end <= now) },
            h("time", {}, e.allDay ? "All day" : time.format(e.start)),
            h("span", { title: e.location ? `${e.title} · ${e.location}` : e.title }, e.title),
          );
          row.addEventListener("click", edit(e));
          list.append(row);
        }
        if (!list.childElementCount) list.append(h("div", { class: "gcal-day" }, "No events"));
        return h("div", { class: "gcal-agenda" }, focus, list);
      };

      /** Seven days: an all-day strip, then the hours with each event where it falls. */
      const week = (now) => {
        const from = startOfWeek(anchor);
        const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
        const today = startOfDay(now);
        const head = h(
          "div",
          { class: "gw-head" },
          h("span"),
          ...days.map((d) => h("div", { class: "gw-day", "data-today": String(d === today) }, dayShort.format(d), h("b", {}, dayNumber.format(d)))),
        );
        const allDay = days.map((d) => events.filter((e) => e.allDay && onDay(e, d)));
        const strip = allDay.some((list) => list.length)
          ? [
              h(
                "div",
                { class: "gw-allday" },
                h("span"),
                ...allDay.map((list) =>
                  h(
                    "div",
                    {},
                    ...list.slice(0, 2).map((e) => {
                      const chip = h("span", { class: "gw-chip", style: `--event: ${e.color}`, title: e.title }, e.title);
                      chip.addEventListener("click", edit(e));
                      return chip;
                    }),
                    ...(list.length > 2 ? [h("span", { class: "gm-more" }, `+${list.length - 2}`)] : []),
                  ),
                ),
              ),
            ]
          : [];
        const hours = h("div", { class: "gw-hours" }, ...Array.from({ length: 23 }, (_, i) => h("span", { style: `top: ${(i + 1) * HOUR_PX}px` }, hourLabel.format(today + (i + 1) * 3600_000))));
        const columns = days.map((d) => {
          const end = addDays(d, 1);
          const col = h("div", { class: "gw-col", "data-today": String(d === today), title: "Drag across the hours to add an event" });
          // Dragging across the hours (or clicking one) opens the calendar page with them marked.
          col.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0 || ev.target !== col) return;
            ev.preventDefault();
            const at = (e) => Math.min(24 * 60, Math.max(0, ((e.clientY - col.getBoundingClientRect().top) / HOUR_PX) * 60));
            const from = Math.min(24 * 60 - 15, Math.floor(at(ev) / 15) * 15);
            let range = [from, from + 60];
            const mark = h("div", { class: "gw-sel" });
            col.append(mark);
            const paint = () => {
              mark.style.top = `${(range[0] / 60) * HOUR_PX}px`;
              mark.style.height = `${((range[1] - range[0]) / 60) * HOUR_PX}px`;
            };
            paint();
            col.setPointerCapture(ev.pointerId);
            const move = (e) => {
              const to = Math.round(at(e) / 15) * 15;
              if (Math.abs(to - from) < 15) return;
              range = to > from ? [from, to] : [to, from + 15];
              paint();
            };
            const up = () => {
              col.removeEventListener("pointermove", move);
              col.removeEventListener("pointerup", up);
              mark.remove();
              const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
              host.openPage({ date: isoDate(d), start: clock(range[0]), end: clock(Math.min(range[1], 24 * 60 - 1)) });
            };
            col.addEventListener("pointermove", move);
            col.addEventListener("pointerup", up);
          });
          const timed = events.filter((e) => !e.allDay && onDay(e, d)).map((e) => ({ e, start: Math.max(e.start, d), end: Math.min(e.end, end) }));
          for (const x of lanes(timed)) {
            const top = ((x.start - d) / 3600_000) * HOUR_PX;
            const height = Math.max(14, ((x.end - x.start) / 3600_000) * HOUR_PX - 1);
            const block = h(
                "div",
                {
                  class: "gw-ev",
                  style: `--event: ${x.e.color}; top: ${top}px; height: ${height}px; left: calc(${(x.lane / x.of) * 100}% + 1px); width: calc(${100 / x.of}% - 2px)`,
                  "data-past": String(x.e.end <= now),
                  title: `${x.e.title}\n${time.format(x.e.start)} – ${time.format(x.e.end)}${x.e.location ? `\n${x.e.location}` : ""}`,
                },
                h("b", {}, x.e.title),
                ...(height >= 26 ? [h("span", {}, time.format(x.e.start))] : []),
              );
            block.addEventListener("click", edit(x.e));
            col.append(block);
          }
          if (d === today) col.append(h("div", { class: "gw-now", style: `top: ${((now - d) / 3600_000) * HOUR_PX}px` }));
          return col;
        });
        const grid = h("div", { class: "gw-grid" }, h("div", { class: "gw-inner", style: `height: ${24 * HOUR_PX}px` }, hours, ...columns));
        grid.addEventListener("scroll", () => (scrolled = grid.scrollTop));
        // Laid out once on screen: then it can be scrolled to the morning, or to where it was.
        const at = scrolled ?? Math.max(0, ((days.includes(today) ? new Date(now).getHours() - 1.5 : 7.5) * HOUR_PX));
        requestAnimationFrame(() => (grid.scrollTop = at));
        return h("div", { class: "gw" }, head, ...strip, grid);
      };

      /** The month's weeks, with what's on each day; a day opens its week. */
      const month = (now) => {
        const first = startOfMonth(anchor);
        const from = startOfWeek(first);
        const inMonth = new Date(first).getMonth();
        const next = new Date(new Date(first).getFullYear(), inMonth + 1, 1).getTime();
        const rows = Math.ceil(Math.round((next - from) / DAY) / 7);
        /** How many events a day has room for under its number; the rest are "+n" beside it. */
        const fits = rows > 5 ? 1 : rows > 4 ? 2 : 3;
        const cells = Array.from({ length: rows * 7 }, (_, i) => {
          const d = addDays(from, i);
          const on = events.filter((e) => onDay(e, d));
          const cell = h(
            "button",
            {
              type: "button",
              class: "gm-cell",
              "data-out": String(new Date(d).getMonth() !== inMonth),
              "data-today": String(d === startOfDay(now)),
              title: on.length ? on.map((e) => `${e.allDay ? "" : `${time.format(e.start)} `}${e.title}`).join("\n") : dayLabel(d, now),
            },
            h("span", { class: "gm-top" }, h("span", { class: "gm-num" }, dayNumber.format(d)), ...(on.length > fits ? [h("span", { class: "gm-more" }, `+${on.length - fits}`)] : [])),
            ...on.slice(0, fits).map((e) => {
              const chip = h("span", { class: "gm-ev", style: `--event: ${e.color}` }, e.title);
              chip.addEventListener("click", edit(e));
              return chip;
            }),
          );
          cell.addEventListener("click", () => show("week", d));
          return cell;
        });
        const grid = h(
          "div",
          { class: "gm", style: `grid-template-rows: auto repeat(${rows}, minmax(0, 1fr))` },
          ...Array.from({ length: 7 }, (_, i) => h("div", { class: "gm-dow" }, dayShort.format(addDays(from, i)))),
          ...cells,
        );
        return grid;
      };

      const draw = (now) => {
        root.dataset.tone = look().tone;
        if (problem === "setup") return empty("Add your Google OAuth client in Settings to begin.", button("Set up", () => host.openSettings(), { class: "primary" }));
        if (problem === "signin") return empty("Sign in to see your calendar here.", button("Sign in with Google", () => void signIn(), { class: "primary" }));
        if (!fetchedAt) return empty("Reading your calendar…");
        const view = host.options().view;
        const body = view === "week" ? week(now) : view === "month" ? month(now) : agenda(now);
        root.replaceChildren(toolbar(view, now), h("div", { class: "gcal-body" }, body));
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
          const key = `${version}|${Math.floor(now / MINUTE)}|${look().tone}|${o.view}|${anchor}|${syncing}`;
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
