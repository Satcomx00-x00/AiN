/**
 * Settings → Notifications: how they show (in the pill, as a bubble, as a corner toast, or as a
 * plugin's notifier), for how long and how they move, do not disturb, and who may send them.
 */
import { h } from "../../../sdk/dom";
import { type SelectOption, select } from "../../../sdk/select";
import {
  ANIMATIONS,
  CORNERS,
  type Corner,
  MAX_RANGE,
  type NotificationSettings,
  SECONDS_RANGE,
  SIDES,
  SPEEDS,
} from "../../notifications";
import { field, rangeControl, segmented, switchControl } from "./controls";

export const NOTIFICATIONS_ICON = `<path d="M8 2.5a4 4 0 0 0-4 4V10l-1.25 1.75h10.5L12 10V6.5a4 4 0 0 0-4-4z"/><path d="M6.6 13.5a1.5 1.5 0 0 0 2.8 0"/>`;
export const NOTIFICATIONS_LEAD = "How your apps and plugins tell you things, and when they keep quiet.";

/** Who may send notifications, and the notifiers that can show them. */
export interface NotificationChoices {
  readonly sources: readonly { readonly id: string; readonly label: string }[];
  readonly notifiers: readonly { readonly id: string; readonly label: string }[];
}

type Patch = (patch: Partial<NotificationSettings>, redraw?: boolean) => void;
type Group = (title: string | null, ...rows: Node[]) => HTMLElement;

const FORMAT_LABELS: Record<string, string> = { pill: "In the pill", bubble: "Bubble", toast: "Corner toast" };
const CORNER_LABELS: Record<Corner, string> = { "top-left": "Top left", "top-right": "Top right", "bottom-left": "Bottom left", "bottom-right": "Bottom right" };
const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const choices = <T extends string>(values: readonly T[], names: Partial<Record<T, string>> = {}) => values.map((value) => ({ value, label: names[value] ?? label(value) }));

function timeInput(value: string, onChange: (v: string) => void, name: string): HTMLInputElement {
  const el = h("input", { class: "time-input", type: "time", value, "aria-label": name });
  el.addEventListener("change", () => el.value && onChange(el.value));
  return el;
}

export function notificationsBody(n: NotificationSettings, c: NotificationChoices, set: Patch, group: Group): HTMLElement[] {
  const formats: SelectOption[] = [
    ...(["pill", "bubble", "toast"] as const).map((value) => ({ value, label: FORMAT_LABELS[value]! })),
    ...c.notifiers.map((x) => ({ value: x.id, label: x.label, badge: "Plugin" })),
  ];
  // A notifier whose file is off shows as a bubble.
  const format = formats.some((f) => f.value === n.format) ? n.format : "bubble";
  const show = [
    field("Show as", "Where a new notification appears.", select(formats, format, (v) => set({ format: v }, true), "Show as").el, true),
    ...(format === "toast" ? [field("Corner", "Of the screen the island is on.", segmented(n.corner, choices(CORNERS, CORNER_LABELS), (v) => set({ corner: v as Corner }), "Corner"))] : []),
    ...(format === "bubble" ? [field("Bubble position", "Under the pill, or beside it.", segmented(n.side, choices(SIDES), (v) => set({ side: v as NotificationSettings["side"] }), "Bubble position"))] : []),
    field("On screen at once", "Older ones leave first.", rangeControl(n.max, MAX_RANGE, (v) => set({ max: v }), "On screen at once")),
  ];
  const timing = [
    field("Keep until closed", "Notifications stay until you close them.", switchControl(n.sticky, (on) => set({ sticky: on }, true), "Keep until closed")),
    ...(n.sticky
      ? []
      : [
          field("Duration", "How long one shows.", rangeControl(n.seconds, { ...SECONDS_RANGE, unit: "s" }, (v) => set({ seconds: v }), "Duration")),
          field("Time remaining bar", "A thin line along the bottom that empties until the notification leaves.", switchControl(n.bar, (on) => set({ bar: on }), "Time remaining bar")),
        ]),
    field("Animation", "How they come and go. Reduced motion in your system settings turns it off.", segmented(n.animation, choices(ANIMATIONS), (v) => set({ animation: v as NotificationSettings["animation"] }), "Animation")),
    field("Speed", undefined, segmented(n.speed, choices(SPEEDS), (v) => set({ speed: v as NotificationSettings["speed"] }), "Animation speed")),
  ];
  const reading = [
    field("Larger text", "Easier to read at a glance.", switchControl(n.largeText, (on) => set({ largeText: on }), "Larger text")),
    field("Action buttons", "Reply, Open and the like, on the notification.", switchControl(n.actions, (on) => set({ actions: on }), "Action buttons")),
  ];
  const quiet = [
    field("Do not disturb", "Notifications go to the history without showing.", switchControl(n.quiet, (on) => set({ quiet: on }), "Do not disturb")),
    field("Every day", "Turns do not disturb on between these times.", switchControl(n.schedule, (on) => set({ schedule: on }, true), "Do not disturb every day")),
    ...(n.schedule
      ? [field("From", undefined, h("div", { class: "time-range" }, timeInput(n.from, (v) => set({ from: v }), "From"), h("span", {}, "to"), timeInput(n.to, (v) => set({ to: v }), "To")))]
      : []),
    field("Let urgent ones through", "Urgent notifications show even in do not disturb.", switchControl(n.urgent, (on) => set({ urgent: on }), "Let urgent ones through")),
  ];
  const muted = new Set(n.muted);
  // Redrawn on each change, so the next one starts from the list as saved.
  const sources = c.sources.map((s) =>
    field(s.label, undefined, switchControl(!muted.has(s.id), (on) => set({ muted: on ? n.muted.filter((m) => m !== s.id) : [...n.muted, s.id] }, true), `Notifications from ${s.label}`)),
  );
  return [
    group("Show", ...show),
    group("Timing and motion", ...timing),
    group("Reading", ...reading),
    group("Do not disturb", ...quiet),
    group("Allowed to notify", ...sources),
  ];
}
