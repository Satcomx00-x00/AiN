import { button, h, icon } from "../../sdk/dom";
import { definePlugin } from "../../sdk/plugin";
import { ago } from "../clipboard/format";
import type { Notification, NotificationsPort } from "./service";

export const BELL = `<path d="M4.25 11V7.5a3.75 3.75 0 0 1 7.5 0V11l1 1.25h-9.5z"/><path d="M6.75 13.75a1.25 1.25 0 0 0 2.5 0"/>`;
const CLOSE = `<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>`;

/** One notification in the history: who sent it, what it says, when, and its actions. */
function row(n: Notification, port: NotificationsPort, now: number): HTMLElement {
  const remove = button(icon(CLOSE), () => port.remove(n.id), { class: "ghost notice-remove", "aria-label": `Remove “${n.title}”`, title: "Remove" });
  const actions = n.actions.map((a) => button(a.label, () => port.act(n.id, a.id), { class: "ghost notice-action" }));
  return h(
    "li",
    { class: "notice", "data-seen": String(n.seen) },
    h("span", { class: "badge", "aria-hidden": "true" }, icon(n.icon)),
    h(
      "div",
      { class: "notice-text" },
      h("b", {}, n.title),
      h("span", {}, n.body ? `${n.source.label} · ${n.body}` : n.source.label),
      ...(actions.length ? [h("div", { class: "notice-actions" }, ...actions)] : []),
    ),
    h("div", { class: "notice-side" }, h("time", { datetime: new Date(n.at).toISOString(), "data-at": String(n.at) }, ago(now - n.at)), remove),
  );
}

/** The Notifications tab: what the island showed or kept while do not disturb was on. */
export const notifications = definePlugin({
  id: "notifications",
  label: "Notification history",
  description: "What your apps and plugins told you, newest first.",
  slots: ["tab"],
  icon: BELL,
  setup({ notifications: port }: { notifications: NotificationsPort }) {
    const list = h("ul", { class: "notices", "aria-label": "Notifications" });
    const empty = h("p", { class: "empty" }, "No notifications.");
    const count = h("span", { class: "eyebrow" });
    const clear = button("Clear all", () => port.clear(), { class: "ghost" });
    let shown: readonly Notification[] = [];

    const draw = (history: readonly Notification[]) => {
      shown = history;
      const unseen = history.filter((n) => !n.seen).length;
      list.replaceChildren(...history.map((n) => row(n, port, Date.now())));
      empty.hidden = history.length > 0;
      clear.hidden = history.length === 0;
      count.textContent = unseen ? `${unseen} new` : "Notifications";
    };
    void port.watch(draw);

    return {
      panel: (root) => root.append(h("div", { class: "notifications" }, h("div", { class: "row" }, count, clear), list, empty)),
      tick: ({ visible, now }) => {
        if (!visible) return;
        // Opening the tab is seeing them; the times move on while it is open.
        if (shown.some((n) => !n.seen)) port.markSeen();
        list.querySelectorAll<HTMLElement>("time[data-at]").forEach((t) => (t.textContent = ago(now - Number(t.dataset.at))));
      },
    };
  },
});
