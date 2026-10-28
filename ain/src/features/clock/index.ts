import { h, odometer } from "../../sdk/dom";
import { choice, toggle } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";

export const isoWeek = (d: Date): number => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
};

const formats = new Map<string, Intl.DateTimeFormat>();
/** Hours and minutes in the chosen format: "auto" follows the system, "12" or "24" force it. */
const hm = (format: string) => {
  let f = formats.get(format);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", ...(format === "auto" ? {} : { hour12: format === "12" }) });
    formats.set(format, f);
  }
  return f;
};
const day = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const short = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });

/** What the clock says on the pill: the time, the date, or both. */
export const clockGlance = (now: number, o: { readonly format: string; readonly show: string }): Glance => {
  const time = hm(o.format).format(now);
  const date = short.format(now);
  return { text: o.show === "date" ? date : o.show === "both" ? `${date} ${time}` : time };
};

export const clock = definePlugin({
  id: "clock",
  label: "Clock",
  description: "Time, date and week.",
  icon: `<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75V8l2.25 1.5"/>`,
  slots: ["glance", "tab"],
  options: {
    format: choice("Time format", "auto", [
      ["auto", "System"],
      ["24", "24-hour"],
      ["12", "12-hour"],
    ]),
    seconds: toggle("Seconds in the tab", true),
    show: {
      ...choice("On the pill", "time", [
        ["time", "Time"],
        ["date", "Date"],
        ["both", "Both"],
      ]),
      pill: true,
    },
  },
  sample: (o) => clockGlance(Date.now(), o),
  setup(_: unknown, host) {
    const time = h("span");
    const sec = h("span", { class: "clock-sec" });
    const date = h("span", { class: "clock-date" });
    const week = h("span", { class: "muted" });
    return {
      panel: (root) => root.append(h("div", { class: "clock" }, h("div", { class: "clock-time" }, time, sec), h("div", { class: "row" }, date, week))),
      tick({ visible, now }) {
        if (!visible) return;
        const d = new Date(now);
        const o = host.options();
        odometer(time, hm(o.format).format(d));
        sec.hidden = !o.seconds;
        odometer(sec, String(d.getSeconds()).padStart(2, "0"));
        date.textContent = day.format(d);
        week.textContent = `Week ${isoWeek(d)}`;
      },
      glance: (now) => clockGlance(now, host.options()),
    };
  },
});
