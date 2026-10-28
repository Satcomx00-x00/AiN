/**
 * Notifications in the standard formats, read as AiN's own `Notice`: freedesktop's (Linux
 * desktops), the W3C's (the web), and Windows toasts' XML. What a format has and AiN hasn't
 * (sounds, timeouts, images by URL or theme name) is left out: the user decides how they show.
 */
import type { AnyNotice, FreedesktopNotice, Notice, NoticeAction, Urgency, WebNotice, WindowsNotice } from "../sdk/notify";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** Only inline SVG is drawn: an icon name or a URL isn't. */
const markup = (v: unknown): string | undefined => (typeof v === "string" && v.trimStart().startsWith("<") ? v : undefined);
/** A notice without the fields a format didn't give. */
const notice = (o: { readonly title: string } & { readonly [K in keyof Notice]?: Notice[K] | undefined }): Notice =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as unknown as Notice;

const isFreedesktop = (n: AnyNotice): n is FreedesktopNotice => "summary" in n;
const isWindows = (n: AnyNotice): n is WindowsNotice => "toastXml" in n;
const isWeb = (n: AnyNotice): n is WebNotice => "options" in n && isObject(n.options);

const FREEDESKTOP_URGENCY: Readonly<Record<number, Urgency>> = { 0: "low", 1: "normal", 2: "urgent" };

/** freedesktop's `Notify` arguments; "default" is the click on the notification, not a button. */
export function fromFreedesktop(n: FreedesktopNotice): Notice {
  const flat = Array.isArray(n.actions) ? n.actions : [];
  const actions: NoticeAction[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i] !== "default") actions.push({ id: String(flat[i]), label: String(flat[i + 1]) });
  const hints = isObject(n.hints) ? n.hints : {};
  return notice({
    title: String(n.summary),
    body: text(n.body),
    icon: markup(n.app_icon),
    actions,
    urgency: typeof hints.urgency === "number" ? FREEDESKTOP_URGENCY[hints.urgency] : undefined,
    tag: typeof n.replaces_id === "number" && n.replaces_id > 0 ? String(n.replaces_id) : undefined,
    category: text(hints.category),
    transient: hints.transient === true ? true : undefined,
  });
}

/** The W3C's `new Notification(title, options)`; a silent one goes to the history only. */
export function fromWeb(n: WebNotice): Notice {
  const o = n.options;
  return notice({
    title: String(n.title),
    body: text(o.body),
    icon: markup(o.icon),
    actions: Array.isArray(o.actions) ? o.actions.filter(isObject).map((a) => ({ id: String(a.action), label: String(a.title) })) : undefined,
    urgency: o.silent === true ? ("low" as const) : undefined,
    tag: text(o.tag) || undefined,
  });
}

/** Scenarios that interrupt: Windows keeps them on screen until handled. */
const URGENT_SCENARIOS = new Set(["urgent", "alarm", "incomingCall"]);

/** A Windows toast's XML: its first text is the title, the next ones the body, and its actions buttons. */
export function fromWindows(n: WindowsNotice, parse: (xml: string) => Document = (xml) => new DOMParser().parseFromString(xml, "text/xml")): Notice {
  const doc = parse(n.toastXml);
  const toast = doc.querySelector("toast");
  if (!toast || doc.querySelector("parsererror")) throw new Error("not a Windows toast: its XML has no <toast>");
  const texts = [...toast.querySelectorAll("visual binding text")].flatMap((t) => t.textContent?.trim() || []);
  const actions = [...toast.querySelectorAll("actions action")]
    .filter((a) => a.getAttribute("activationType") !== "system")
    .map((a) => ({ id: a.getAttribute("arguments") ?? "", label: a.getAttribute("content") ?? "" }));
  const tag = n.tag ? (n.group ? `${n.group}/${n.tag}` : n.tag) : undefined;
  return notice({
    title: texts[0] ?? "",
    body: texts.slice(1).join("\n") || undefined,
    actions,
    urgency: URGENT_SCENARIOS.has(toast.getAttribute("scenario") ?? "") ? ("urgent" as const) : undefined,
    tag,
  });
}

/** Any notice `host.notify` takes, as AiN's own. */
export function toNotice(n: AnyNotice): Notice {
  if (isFreedesktop(n)) return fromFreedesktop(n);
  if (isWindows(n)) return fromWindows(n);
  if (isWeb(n)) return fromWeb(n);
  return n;
}
