import { h, icon } from "../../sdk/dom";
import type { PopupContext, PopupView } from "../../sdk/plugin";
import type { Clip, ClipboardPort } from "./service";
import { ago, describe, mark } from "./format";

const SEARCH = `<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>`;
/** Alt+1…9 picks directly. */
const QUICK = 9;

/** Clips whose text (for an image, "image" and its size) contains every word of the query, in history order. */
export const matching = (clips: readonly Clip[], query: string): Clip[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return clips.filter((c) => words.every((w) => (c.image ? describe(c) : c.text).toLowerCase().includes(w)));
};

const kbd = (text: string) => h("kbd", {}, text);

/** The clipboard history popup: search, arrows, Enter or Alt+number to paste, Esc to close. */
export function picker(root: HTMLElement, ctx: PopupContext<{ clipboard: ClipboardPort }, { paste: boolean }>): PopupView {
  let clips: Clip[] = [];
  let shown: Clip[] = [];
  let index = 0;

  const search = h("input", {
    class: "pk-search",
    type: "text",
    placeholder: "Search your clipboard…",
    autocomplete: "off",
    spellcheck: "false",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "pk-list",
    "aria-label": "Search clipboard history",
  });
  const list = h("ul", { class: "pk-list", id: "pk-list", role: "listbox", "aria-label": "Clipboard history" });
  const empty = h("p", { class: "pk-empty" });
  const count = h("span", { class: "pk-count" });
  const action = h("span");
  root.append(
    h("header", { class: "pk-head" }, icon(SEARCH, "icon pk-search-icon"), search),
    list,
    empty,
    h("footer", { class: "pk-foot" }, count, h("span", { class: "pk-keys" }, kbd("↑"), kbd("↓"), " Navigate ", kbd("↵"), action, kbd("Esc"), " Close")),
  );

  const choose = async (clip: Clip | undefined) => {
    if (!clip) return;
    await ctx.services.clipboard.restore(clip.id).catch(() => {});
    if (ctx.options().paste) await ctx.paste().catch(() => ctx.close());
    else ctx.close();
  };

  const select = (next: number) => {
    index = Math.max(0, Math.min(next, shown.length - 1));
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === index)));
    list.children[index]?.scrollIntoView({ block: "nearest" });
    const active = list.children[index];
    if (active) search.setAttribute("aria-activedescendant", active.id);
  };

  const draw = () => {
    shown = matching(clips, search.value);
    const now = Date.now();
    list.replaceChildren(
      ...shown.map((clip, i) => {
        const li = h(
          "li",
          { id: `pk-${i}`, role: "option", "aria-selected": "false", "data-kind": clip.image ? "image" : "text" },
          mark(clip),
          h("span", { class: "pk-text" }, describe(clip, 160)),
          h("span", { class: "pk-meta" }, i < QUICK ? h("span", { class: "pk-num" }, `Alt ${i + 1}`) : "", ago(now - clip.copiedAt)),
        );
        li.addEventListener("mousemove", () => index !== i && select(i));
        li.addEventListener("click", () => void choose(clip));
        return li;
      }),
    );
    empty.hidden = shown.length > 0;
    empty.textContent = clips.length ? "Nothing matches." : "Nothing copied yet — copy some text or an image and it shows up here.";
    count.textContent = `${shown.length} of ${clips.length}`;
    select(0);
  };

  search.addEventListener("input", draw);
  search.addEventListener("keydown", (e) => {
    const quick = e.altKey && /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) - 1 : -1;
    if (quick >= 0) void choose(shown[quick]);
    else if (e.key === "ArrowDown") select(index + 1);
    else if (e.key === "ArrowUp") select(index - 1);
    else if (e.key === "Enter") void choose(shown[index]);
    else return;
    e.preventDefault();
  });

  return {
    show() {
      search.value = "";
      action.textContent = ctx.options().paste ? " Paste " : " Copy ";
      search.focus();
      ctx.services.clipboard.history().then(
        (all) => {
          clips = all;
          draw();
        },
        () => draw(),
      );
    },
  };
}
