import { button, h, icon } from "../../sdk/dom";
import { list, toggle } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";
import type { Output, Source, VolumePort } from "./service";

const SPEAKER = `<path d="M2.75 6v4h2.5l3.5 3V3l-3.5 3z" fill="currentColor"/><path d="M11 5.75a3.25 3.25 0 0 1 0 4.5M12.75 4a5.75 5.75 0 0 1 0 8"/>`;
const MUTED = `<path d="M2.75 6v4h2.5l3.5 3V3l-3.5 3z" fill="currentColor"/><path d="M11 6l3.5 4M14.5 6L11 10"/>`;
const DEVICE = `<rect x="3.5" y="2" width="9" height="12" rx="2"/><circle cx="8" cy="9.5" r="2.25"/><path d="M8 4.75v.01"/>`;
const APP = `<rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="M6.5 10.5V6l4-1v4.5"/><circle cx="5.5" cy="10.5" r="1"/><circle cx="9.5" cy="9.5" r="1"/>`;
const PIN = `<path d="M6 2.5h4l-.5 4 2 2v1h-7v-1l2-2z"/><path d="M8 9.5v4"/>`;
const LIST = `<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01"/>`;
/** How long a volume change shows on the collapsed pill. */
const OSD_MS = 1600;
const METER_MS = 80;

export const percent = (level: number) => `${Math.round(level * 100)}%`;

/** "SteelSeries Sonar - Gaming (SteelSeries Sonar Virtual Audio Device)" → "SteelSeries Sonar - Gaming". */
export const shortName = (name: string) => name.replace(/\s*\([^()]*\)\s*$/, "") || name;

/** Widens the pill into a level bar briefly after a change, like the OS volume pop-up. */
export const volumeGlance = (out: Output | null, changedAt: number, now: number): Glance | null => {
  if (!out || now - changedAt >= OSD_MS) return null;
  return out.muted
    ? { text: "Muted", level: 0, tone: "muted", wide: true }
    : { text: percent(out.level), level: out.level, wide: true };
};

export const changed = (before: Output | null, after: Output | null) =>
  !!before && !!after && (before.level !== after.level || before.muted !== after.muted);

/** Sources to show: the pinned ones that exist, in pin order; with no pins, the default output. */
export function shown(sources: readonly Source[], pinned: readonly string[]): Source[] {
  const byName = new Map(sources.map((s) => [shortName(s.name), s]));
  const picked = pinned.flatMap((name) => byName.get(name) ?? []);
  return picked.length ? picked : sources.filter((s) => s.default);
}

/** Pins or unpins a source by its short name. */
export const togglePin = (pinned: readonly string[], name: string): string[] =>
  pinned.includes(name) ? pinned.filter((n) => n !== name) : [...pinned, name];

interface Row {
  readonly el: HTMLElement;
  update(s: Source): void;
}

export const volume = definePlugin({
  id: "volume",
  label: "Volume",
  description: "Volume mixer for outputs and apps.",
  icon: SPEAKER,
  slots: ["glance", "tab"],
  options: {
    popup: toggle("Pop-up on volume changes", true),
    pinned: list("Pinned sources", [], "Device or app name"),
  },
  setup({ volume: port }: { volume: VolumePort }, host) {
    let out: Output | null = null;
    let sources: Source[] = [];
    let changedAt = -Infinity;
    let picking = false;
    let meterTimer: ReturnType<typeof setInterval> | undefined;
    const rows = new Map<string, Row>();
    const meter = h("div", { class: "meter", "aria-hidden": "true" }, h("i"));

    /** One mixer row: icon, name, slider, value, mute. Keyed by source id so drags survive updates. */
    const row = (s: Source): Row => {
      let dragging = false;
      let current = s;
      const name = h("span", { class: "mx-name" });
      const value = h("span", { class: "mx-value" });
      const slider = h("input", { type: "range", min: "0", max: "100", step: "1", class: "slider" });
      const mute = button("", () => port.setMuted(!current.muted, current.id).catch(() => {}), { class: "mx-mute" });
      const el = h(
        "div",
        { class: "mx-row" },
        h("span", { class: "mx-icon", "aria-hidden": "true" }, icon(s.kind === "device" ? DEVICE : APP)),
        name,
        slider,
        value,
        mute,
      );
      slider.addEventListener("pointerdown", () => (dragging = true));
      slider.addEventListener("pointerup", () => (dragging = false));
      slider.addEventListener("input", () => {
        slider.style.setProperty("--p", String(slider.valueAsNumber / 100));
        value.textContent = `${slider.value}%`;
        port.setLevel(slider.valueAsNumber / 100, current.id).catch(() => {});
      });
      const update = (next: Source) => {
        current = next;
        name.textContent = shortName(next.name);
        el.title = next.name;
        slider.setAttribute("aria-label", `${shortName(next.name)} volume`);
        el.dataset.muted = String(next.muted);
        mute.replaceChildren(icon(next.muted ? MUTED : SPEAKER));
        mute.setAttribute("aria-label", `${next.muted ? "Unmute" : "Mute"} ${shortName(next.name)}`);
        if (!dragging) {
          slider.value = String(Math.round(next.level * 100));
          value.textContent = next.muted ? "Off" : percent(next.level);
        }
        slider.style.setProperty("--p", String(slider.valueAsNumber / 100));
      };
      update(s);
      return { el, update };
    };

    const mixer = h("div", { class: "mx-list" });
    const picker = h("ul", { class: "mx-pick", "aria-label": "Sources" });
    const empty = h("p", { class: "empty" }, "No audio output");
    const switcher = button("", () => {
      picking = !picking;
      draw();
    }, { class: "ghost mx-switch" });
    const title = h("span", { class: "eyebrow" });
    const body = h("div", { class: "volume" }, h("div", { class: "row" }, title, switcher), mixer, picker);

    const drawPicker = () => {
      const pinned = host.options().pinned;
      picker.replaceChildren(
        ...sources.map((s) => {
          const short = shortName(s.name);
          const b = button(
            h(
              "span",
              { class: "mx-pick-in" },
              h("span", { class: "mx-icon", "aria-hidden": "true" }, icon(s.kind === "device" ? DEVICE : APP)),
              h("span", { class: "mx-name" }, short),
              ...(s.kind === "app" && s.active ? [h("span", { class: "mx-live", title: "Playing" })] : []),
              h("span", { class: "mx-pin", "aria-hidden": "true" }, icon(PIN)),
            ),
            () => host.setOptions({ pinned: togglePin(host.options().pinned, short) }),
            { class: "mx-pick-row", "aria-pressed": String(pinned.includes(short)), title: s.name },
          );
          return h("li", {}, b);
        }),
      );
    };

    const drawMixer = () => {
      const list = shown(sources, host.options().pinned);
      const keep = new Set(list.map((s) => s.id));
      for (const [id, r] of rows) {
        if (keep.has(id)) continue;
        r.el.remove();
        rows.delete(id);
      }
      const els = list.map((s) => {
        const existing = rows.get(s.id);
        existing?.update(s);
        const r = existing ?? row(s);
        rows.set(s.id, r);
        return r.el;
      });
      if (els.some((el, i) => mixer.children[i] !== el) || mixer.children.length !== els.length) mixer.replaceChildren(...els);
      // The live meter sits under the default output's row.
      const def = list.find((s) => s.default);
      const anchor = def && rows.get(def.id)?.el;
      if (anchor) anchor.append(meter);
      else meter.remove();
    };

    const draw = () => {
      const has = sources.length > 0 || !!out;
      body.hidden = !has;
      empty.hidden = has;
      title.textContent = picking ? "Pin sources" : "Volume";
      switcher.replaceChildren(...(picking ? ["Done"] : [icon(LIST), "Sources"]));
      mixer.hidden = picking;
      picker.hidden = !picking;
      if (picking) drawPicker();
      else drawMixer();
    };

    const meterOn = (on: boolean) => {
      if (on && !meterTimer)
        meterTimer = setInterval(() => {
          port.peak().then((p) => meter.style.setProperty("--p", String(p)), () => {});
        }, METER_MS);
      if (!on && meterTimer) {
        clearInterval(meterTimer);
        meterTimer = undefined;
        meter.style.setProperty("--p", "0");
      }
    };

    void port.watch((next) => {
      if (changed(out, next)) changedAt = Date.now();
      out = next;
      host.refresh();
    });
    void port.watchSources((next) => {
      sources = next;
      draw();
    });

    return {
      panel: (root) => root.append(body, empty),
      tick: ({ visible }) => {
        meterOn(visible && !picking);
        // Pins can also change from Settings; redraw while on screen, and leave the picker when hidden.
        if (!visible) picking = false;
        draw();
      },
      glance: (now) => (host.options().popup ? volumeGlance(out, changedAt, now) : null),
    };
  },
});
