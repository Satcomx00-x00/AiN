import { EASE_OUT, button, h, reducedMotion } from "../../core/dom";
import { toggle } from "../../core/options";
import { definePlugin } from "../../core/plugin";
import type { Clip, ClipboardPort } from "./api";
import { ago, badge, preview } from "./format";
import { picker } from "./picker";

export { ago, badge, kindOf, preview } from "./format";
export type { Kind } from "./format";

const FLASH_MS = 1400;

type Row = { li: HTMLLIElement; meta: HTMLSpanElement; at: number; copied: boolean };

export const clipboard = definePlugin({
  id: "clipboard",
  label: "Clipboard",
  description: "Your recent copied texts, one click to copy again. Kept in memory only.",
  slots: ["tab"],
  options: {
    paste: toggle("Paste after choosing from the shortcut", true, "Otherwise the choice is only copied, ready for Ctrl+V."),
  },
  commands: [
    {
      id: "history",
      label: "Clipboard history",
      description: "Pick something you copied and paste it where you were typing.",
      // Win+B itself belongs to Windows (it focuses the tray), so the default adds Shift.
      shortcut: "Super+Shift+KeyB",
      popup: picker,
    },
  ],
  icon: `<rect x="3.25" y="3" width="9.5" height="11.25" rx="2"/><path d="M6 3V2.25h4V3M5.75 7.5h4.5M5.75 10.25h3"/>`,
  setup({ clipboard: port }: { clipboard: ClipboardPort }) {
    const list = h("ul", { class: "clips" });
    const empty = h("p", { class: "empty" }, "Copy some text — it shows up here.");
    const count = h("span", { class: "eyebrow" });
    const clear = button("Clear", async () => {
      await port.clear();
      await refresh();
    }, { class: "ghost" });
    const rows = new Map<string, Row>();

    const create = (text: string): Row => {
      const meta = h("span", { class: "clip-meta" });
      const btn = button(h("span", { class: "clip-in" }, badge(text), h("span", { class: "clip-text" }, preview(text)), meta), async () => {
        const ok = await port.copy(text).then(
          () => true,
          () => false,
        );
        row.copied = true;
        btn.dataset.copied = String(ok);
        meta.textContent = ok ? "Copied" : "Failed";
        setTimeout(() => {
          row.copied = false;
          delete btn.dataset.copied;
          meta.textContent = ago(Date.now() - row.at);
        }, FLASH_MS);
      }, { class: "clip", title: preview(text, 400) });
      const row: Row = { li: h("li", {}, btn), meta, at: 0, copied: false };
      return row;
    };

    /** Keyed render so rows keep their state, then FLIP-animates moves and entrances. */
    const draw = (clips: Clip[], now: number) => {
      const before = new Map([...rows.values()].map((r) => [r, r.li.getBoundingClientRect().top]));
      const keep = new Set(clips.map((c) => c.text));
      for (const [text, r] of rows) {
        if (keep.has(text)) continue;
        rows.delete(text);
        r.li.remove();
      }
      const ordered = clips.map((c) => {
        const r = rows.get(c.text) ?? create(c.text);
        rows.set(c.text, r);
        r.at = c.copiedAt;
        if (!r.copied) r.meta.textContent = ago(now - c.copiedAt);
        return r;
      });
      if (ordered.some((r, i) => list.children[i] !== r.li) || list.children.length !== ordered.length)
        list.replaceChildren(...ordered.map((r) => r.li));
      empty.hidden = clips.length > 0;
      clear.hidden = clips.length === 0;
      count.textContent = clips.length ? `${clips.length} recent` : "History";
      if (reducedMotion()) return;
      ordered.forEach((r, i) => {
        const was = before.get(r);
        if (was === undefined) {
          r.li.animate([{ opacity: 0, transform: "translateY(-6px) scale(0.98)" }, { opacity: 1, transform: "none" }], {
            duration: 360,
            delay: i * 35,
            easing: EASE_OUT,
            fill: "backwards",
          });
        } else {
          const dy = was - r.li.getBoundingClientRect().top;
          if (dy) r.li.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 420, easing: EASE_OUT });
        }
      });
    };

    const refresh = async () => draw(await port.history(), Date.now());

    return {
      panel: (root) => root.append(h("div", { class: "clipboard" }, h("div", { class: "row" }, count, clear), list, empty)),
      tick: ({ visible }) => (visible ? refresh() : undefined),
    };
  },
});
