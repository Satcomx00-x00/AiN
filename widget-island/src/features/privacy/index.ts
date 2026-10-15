import { h } from "../../sdk/dom";
import { list } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";
import type { PrivacyPort, Usage } from "./service";

const SHIELD = `<path d="M8 1.75l5 2v4c0 3.1-2.1 5.4-5 6.5-2.9-1.1-5-3.4-5-6.5v-4z"/><circle cx="8" cy="7.25" r="1.5"/>`;
const GLANCE_CHARS = 14;
/** Chips shown per row before the rest fold into "+N". */
const CHIPS = 3;

/** The first few app names, and how many more there are. */
export const chipsFor = (names: readonly string[], max = CHIPS): { shown: string[]; more: number } => ({
  shown: names.slice(0, max),
  more: Math.max(0, names.length - max),
});

export const filter = (usage: Usage, ignore: ReadonlySet<string>): Usage => ({
  mic: usage.mic.filter((a) => !ignore.has(a)),
  camera: usage.camera.filter((a) => !ignore.has(a)),
});

/** Camera wins the mark; the text names the app, or how many there are. */
export const privacyGlance = (usage: Usage | null): Glance | null => {
  if (!usage) return null;
  const apps = [...new Set([...usage.camera, ...usage.mic])];
  const [only] = apps;
  if (!only) return null;
  const text = apps.length === 1 ? (only.length > GLANCE_CHARS ? `${only.slice(0, GLANCE_CHARS - 1)}…` : only) : `${apps.length} apps`;
  return { text, mark: usage.camera.length ? "camera" : "mic" };
};

export const privacy = definePlugin({
  id: "privacy",
  label: "Mic & camera",
  description: "Which apps are using your microphone (orange) or camera (green) right now.",
  icon: SHIELD,
  slots: ["glance", "tab"],
  options: {
    ignore: list(
      "Ignore these apps",
      [],
      "App name, e.g. SteelSeriesSonar",
      "Background services that always hold the mic would otherwise keep the indicator on.",
    ),
  },
  setup({ privacy: port }: { privacy: PrivacyPort }, host) {
    let raw: Usage | null = null;
    /** Usage without ignored apps, read fresh so option changes apply at once. */
    const usage = () => raw && filter(raw, new Set(host.options().ignore));
    const row = (kind: "mic" | "camera", label: string) => {
      const apps = h("span", { class: "apps" });
      const el = h("div", { class: "priv-row", "data-kind": kind }, h("span", { class: "dot" }), h("span", { class: "eyebrow" }, label), apps);
      return {
        el,
        set: (names: readonly string[]) => {
          el.dataset.active = String(names.length > 0);
          if (!names.length) return void apps.replaceChildren("Not in use");
          const { shown, more } = chipsFor(names);
          apps.title = names.join("\n");
          apps.replaceChildren(
            ...shown.map((n) => h("span", { class: "app-chip" }, n)),
            ...(more ? [h("span", { class: "app-chip more" }, `+${more}`)] : []),
          );
        },
      };
    };
    const mic = row("mic", "Microphone");
    const camera = row("camera", "Camera");
    const body = h("div", { class: "privacy" }, mic.el, camera.el);
    const empty = h("p", { class: "empty" }, "Not available on this system");

    const draw = () => {
      const u = usage();
      body.hidden = !u;
      empty.hidden = !!u;
      mic.set(u?.mic ?? []);
      camera.set(u?.camera ?? []);
    };

    void port.watch((next) => {
      raw = next;
      draw();
      host.refresh();
    });

    return {
      panel: (root) => root.append(body, empty),
      tick: ({ visible }) => (visible ? draw() : undefined),
      glance: () => privacyGlance(usage()),
    };
  },
});
