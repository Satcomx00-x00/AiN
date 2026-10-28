/**
 * The notification center: what plugins (and, later, the system) post, the history the island
 * keeps, and the user's rules (do not disturb, each source on or off). Plain logic: the island
 * draws what it is told to show, and the Settings page edits `NotificationSettings`.
 */
import { z } from "zod";
import { type HookResult, MAX_ACTIONS, type Notice, type NoticeSource, type Notification, type Urgency } from "../sdk/notify";

export const FORMATS = ["pill", "bubble", "toast"] as const;
export const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export const SIDES = ["left", "center", "right"] as const;
export const ANIMATIONS = ["slide", "fade", "pop", "none"] as const;
export const SPEEDS = ["fast", "normal", "slow"] as const;

export type Corner = (typeof CORNERS)[number];
export type Side = (typeof SIDES)[number];
export type Animation = (typeof ANIMATIONS)[number];
export type Speed = (typeof SPEEDS)[number];

export interface NotificationSettings {
  /** "pill", "bubble", "toast", or a notifier's id (from a plugin file). */
  readonly format: string;
  readonly corner: Corner;
  readonly side: Side;
  /** How long one shows, in s, unless `sticky`. */
  readonly seconds: number;
  /** Shown until closed. */
  readonly sticky: boolean;
  /** A thin bar along the bottom shows the time left before it leaves. */
  readonly bar: boolean;
  /** Most on screen at once (bubbles and toasts); older ones leave. */
  readonly max: number;
  readonly actions: boolean;
  readonly largeText: boolean;
  readonly animation: Animation;
  readonly speed: Speed;
  /** Do not disturb, now. */
  readonly quiet: boolean;
  /** Do not disturb every day between `from` and `to` ("HH:MM", local time). */
  readonly schedule: boolean;
  readonly from: string;
  readonly to: string;
  /** Urgent ones show even in do not disturb. */
  readonly urgent: boolean;
  /** Sources turned off: their notifications are dropped. */
  readonly muted: readonly string[];
}

export const SECONDS_RANGE = { min: 2, max: 15, step: 1 } as const;
export const MAX_RANGE = { min: 1, max: 5, step: 1 } as const;
/** Animation lengths, in ms. */
export const SPEED_MS: Readonly<Record<Speed, number>> = { fast: 180, normal: 300, slow: 500 };
/** Most notifications the history keeps; the oldest go first. */
export const HISTORY = 50;

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  format: "bubble",
  corner: "top-right",
  side: "center",
  seconds: 5,
  sticky: false,
  bar: true,
  max: 3,
  actions: true,
  largeText: false,
  animation: "slide",
  speed: "normal",
  quiet: false,
  schedule: false,
  from: "22:00",
  to: "07:00",
  urgent: true,
  muted: [],
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const FORMAT = /^[a-z][a-z0-9-]{1,31}$/;

/** Reads stored notification settings, keeping every valid field. */
export function parseNotifications(raw: unknown, fallback = DEFAULT_NOTIFICATIONS): NotificationSettings {
  const f = fallback;
  const int = (r: { min: number; max: number }, d: number) => z.number().int().min(r.min).max(r.max).catch(d);
  const schema = z.object({
    format: z.string().regex(FORMAT).catch(f.format),
    corner: z.enum(CORNERS).catch(f.corner),
    side: z.enum(SIDES).catch(f.side),
    seconds: int(SECONDS_RANGE, f.seconds),
    sticky: z.boolean().catch(f.sticky),
    bar: z.boolean().catch(f.bar),
    max: int(MAX_RANGE, f.max),
    actions: z.boolean().catch(f.actions),
    largeText: z.boolean().catch(f.largeText),
    animation: z.enum(ANIMATIONS).catch(f.animation),
    speed: z.enum(SPEEDS).catch(f.speed),
    quiet: z.boolean().catch(f.quiet),
    schedule: z.boolean().catch(f.schedule),
    from: z.string().regex(TIME).catch(f.from),
    to: z.string().regex(TIME).catch(f.to),
    urgent: z.boolean().catch(f.urgent),
    muted: z
      .array(z.string())
      .transform((l) => [...new Set(l)])
      .catch([...f.muted]),
  });
  // Every field falls back on its own, so any object reads.
  return schema.parse(typeof raw === "object" && raw !== null ? raw : {});
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether `at` falls in the daily quiet hours `from`–`to`, which may span midnight. */
export function inQuietHours(s: Pick<NotificationSettings, "schedule" | "from" | "to">, at: Date): boolean {
  if (!s.schedule || s.from === s.to) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  const [from, to] = [minutes(s.from), minutes(s.to)];
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** Do not disturb is on: by hand, or by the schedule. */
export const isQuiet = (s: NotificationSettings, at: Date): boolean => s.quiet || inQuietHours(s, at);

/** What becomes of a notification: shown, only kept in the history, or dropped (its source is off). */
export type Fate = "show" | "history" | "drop";

export function fate(n: Pick<Notification, "source" | "urgency">, s: NotificationSettings, at: Date): Fate {
  if (s.muted.includes(n.source.id)) return "drop";
  if (n.urgency === "low") return "history";
  if (isQuiet(s, at) && !(n.urgency === "urgent" && s.urgent)) return "history";
  return "show";
}

const URGENCIES = new Set<Urgency>(["low", "normal", "urgent"]);
const clip = (text: unknown, max: number) => (typeof text === "string" ? text.trim().slice(0, max) : "");

/** A posted notice, checked and trimmed: plugins can post anything. */
export function normalize(id: string, source: NoticeSource, notice: Partial<Notice>, at: number, base?: Notification): Notification {
  const actions = Array.isArray(notice.actions)
    ? notice.actions
        .filter((a) => typeof a?.id === "string" && typeof a.label === "string" && a.id && a.label.trim())
        .slice(0, MAX_ACTIONS)
        .map((a) => ({ id: a.id, label: clip(a.label, 24) }))
    : undefined;
  return {
    id,
    source,
    title: notice.title !== undefined ? clip(notice.title, 120) : (base?.title ?? ""),
    body: notice.body !== undefined ? clip(notice.body, 400) : (base?.body ?? ""),
    icon: typeof notice.icon === "string" ? notice.icon : (base?.icon ?? source.icon),
    actions: actions ?? base?.actions ?? [],
    urgency: notice.urgency && URGENCIES.has(notice.urgency) ? notice.urgency : (base?.urgency ?? "normal"),
    tag: typeof notice.tag === "string" && notice.tag ? notice.tag : (base?.tag ?? null),
    category: typeof notice.category === "string" && notice.category.trim() ? clip(notice.category, 64) : (base?.category ?? null),
    transient: typeof notice.transient === "boolean" ? notice.transient : (base?.transient ?? false),
    at,
    seen: false,
  };
}

/** A hook's changed notification, as a notice to apply over the original. */
const asNotice = ({ title, body, icon, actions, urgency, tag, category, transient }: Notification): Partial<Notice> => ({
  title,
  body,
  icon,
  actions,
  urgency,
  transient,
  ...(tag ? { tag } : {}),
  ...(category ? { category } : {}),
});

/** A `notifications` hook, from a plugin allowed to see every source. */
export interface Hook {
  readonly pluginId: string;
  readonly run: (n: Notification) => HookResult;
}

/** Runs the hooks in order; a hook can't touch notifications from its own plugin, nor change the id or source. */
export function runHooks(n: Notification, hooks: readonly Hook[], log: (message: string) => void = console.warn): Notification | "silent" | null {
  let current = n;
  let silent = false;
  for (const hook of hooks) {
    if (hook.pluginId === n.source.id) continue;
    let out: HookResult;
    try {
      out = hook.run(current);
    } catch (e) {
      log(`[notifications] hook of "${hook.pluginId}" failed: ${String(e)}`);
      continue;
    }
    if (out === null) return null;
    if (out === "silent") silent = true;
    else if (typeof out === "object" && out !== null) current = normalize(n.id, n.source, asNotice(out), n.at, current);
  }
  return silent ? "silent" : current;
}

/** What the island and the history see happen. */
export interface CenterEvents {
  /** To show now. */
  show(n: Notification): void;
  /** Changed while shown (`update`), or to take off the screen (`gone`). */
  update(n: Notification): void;
  gone(id: string): void;
  /** An action was pressed: the source plugin hears it. */
  action(n: Notification, actionId: string): void;
}

export interface Center {
  configure(settings: NotificationSettings): void;
  setHooks(hooks: readonly Hook[]): void;
  post(source: NoticeSource, notice: Notice): string;
  /** Its time on screen ran out: a transient one is forgotten. */
  expire(id: string): void;
  update(id: string, patch: Partial<Notice>): void;
  /** Takes it back: off the screen and out of the history. */
  remove(id: string): void;
  /** Closed on screen by the user: it stays in the history, seen. */
  close(id: string): void;
  act(id: string, actionId: string): void;
  clear(): void;
  markSeen(): void;
  list(): readonly Notification[];
  unseen(): number;
  watch(onChange: (history: readonly Notification[]) => void): () => void;
  listen(events: Partial<CenterEvents>): () => void;
}

export function center(now: () => number = Date.now, log: (message: string) => void = console.warn): Center {
  let settings = DEFAULT_NOTIFICATIONS;
  let hooks: readonly Hook[] = [];
  let history: Notification[] = [];
  /** Transient ones on screen: never in the history. */
  const live = new Map<string, Notification>();
  let seq = 0;
  const watchers = new Set<(h: readonly Notification[]) => void>();
  const listeners = new Set<Partial<CenterEvents>>();
  const changed = () => watchers.forEach((w) => w(history));
  const emit = <K extends keyof CenterEvents>(k: K, ...args: Parameters<CenterEvents[K]>) =>
    listeners.forEach((l) => (l[k] as ((...a: Parameters<CenterEvents[K]>) => void) | undefined)?.(...args));
  const find = (id: string) => live.get(id) ?? history.find((n) => n.id === id);
  const replace = (n: Notification) => {
    if (live.has(n.id)) live.set(n.id, n);
    else history = history.map((h) => (h.id === n.id ? n : h));
  };

  /** Hooks, then the user's rules; returns whether it shows. */
  const admit = (n: Notification): Notification | null => {
    const hooked = runHooks(n, hooks, log);
    if (hooked === null) return null;
    const kept = hooked === "silent" ? n : hooked;
    const f = fate(kept, settings, new Date(now()));
    if (f === "drop") return null;
    // Shown or nothing: a transient one is never kept.
    if (kept.transient) {
      if (f !== "show" || hooked === "silent") return null;
      live.set(kept.id, kept);
      emit("show", kept);
      return kept;
    }
    history = [kept, ...history.filter((h) => h.id !== kept.id)].slice(0, HISTORY);
    changed();
    if (f === "show" && hooked !== "silent") emit("show", kept);
    return kept;
  };

  return {
    configure: (next) => void (settings = next),
    setHooks: (next) => void (hooks = next),
    post(source, notice) {
      const tagged = typeof notice.tag === "string" && notice.tag ? [...live.values(), ...history].find((h) => h.source.id === source.id && h.tag === notice.tag) : undefined;
      const id = tagged?.id ?? `n${++seq}`;
      if (tagged) {
        live.delete(tagged.id);
        emit("gone", tagged.id);
      }
      admit(normalize(id, source, notice, now()));
      return id;
    },
    expire: (id) => void live.delete(id),
    update(id, patch) {
      const n = find(id);
      if (!n) return;
      const next = { ...normalize(id, n.source, patch, now(), n), seen: n.seen };
      replace(next);
      if (!live.has(id)) changed();
      emit("update", next);
    },
    remove(id) {
      if (!find(id)) return;
      live.delete(id);
      history = history.filter((h) => h.id !== id);
      changed();
      emit("gone", id);
    },
    close(id) {
      const n = find(id);
      if (!n) return;
      if (live.delete(id)) return emit("gone", id);
      if (!n.seen) {
        replace({ ...n, seen: true });
        changed();
      }
      emit("gone", id);
    },
    act(id, actionId) {
      const n = find(id);
      if (!n?.actions.some((a) => a.id === actionId)) return;
      if (!live.delete(id)) {
        replace({ ...n, seen: true });
        changed();
      }
      emit("gone", id);
      emit("action", n, actionId);
    },
    clear() {
      const ids = history.map((h) => h.id);
      history = [];
      changed();
      ids.forEach((id) => emit("gone", id));
    },
    markSeen() {
      if (!history.some((h) => !h.seen)) return;
      history = history.map((h) => (h.seen ? h : { ...h, seen: true }));
      changed();
    },
    list: () => history,
    unseen: () => history.filter((h) => !h.seen).length,
    watch(onChange) {
      watchers.add(onChange);
      onChange(history);
      return () => watchers.delete(onChange);
    },
    listen(events) {
      listeners.add(events);
      return () => listeners.delete(events);
    },
  };
}
