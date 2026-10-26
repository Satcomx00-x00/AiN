import { h, icon } from "../../sdk/dom";
import { isMac, keycaps } from "../../sdk/platform";
import type { PopupContext, PopupView } from "../../sdk/plugin";
import type { ClipboardPort } from "../clipboard/service";
import { type Action, type Item, type Kind, type Mode, type Provider, parseQuery, rank } from "./items";
import { ENGINES, ICONS, appsProvider, calcProvider, commandsProvider, filesProvider, shellProvider, systemProvider, webProvider } from "./providers";
import { type Recent, localRecent } from "./recent";
import type { PalettePort } from "./service";

export interface PaletteOptions {
  readonly files: boolean;
  readonly engine: string;
  readonly confirm: boolean;
}

export type PaletteContext = PopupContext<{ palette: PalettePort; clipboard: ClipboardPort }, PaletteOptions>;

/** The palette's own command, left out of the commands it lists. */
export const SELF = "palette.open";

const SEARCH = `<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>`;

const KINDS: Readonly<Record<Kind, string>> = {
  app: "App",
  file: "File",
  folder: "Folder",
  calc: "Calculator",
  web: "Web",
  link: "Link",
  shell: "Terminal",
  system: "System",
  command: "Command",
};

const MODES: Readonly<Partial<Record<Mode, string>>> = { shell: "Terminal", web: "Web", calc: "Calculator", path: "Files" };

const EMPTY: Readonly<Record<Mode, string>> = {
  all: "Type to find apps, files and commands. Start with > to run a command line, ? to search the web, = to calculate.",
  shell: "Type a command line to run in a new terminal window.",
  web: "Type what to search the web for.",
  calc: "Type a calculation, like 12 * (3 + 4) or sqrt(2).",
  path: "Nothing there.",
};

/** The title with the matched characters marked. */
export function highlight(title: string, hits: readonly number[]): Node[] {
  const marked = new Set(hits);
  const out: Node[] = [];
  let run = "";
  let inMark = false;
  const flush = () => {
    if (run) out.push(inMark ? h("mark", {}, run) : document.createTextNode(run));
    run = "";
  };
  [...title].forEach((c, i) => {
    if (marked.has(i) !== inMark) {
      flush();
      inMark = !inMark;
    }
    run += c;
  });
  flush();
  return out;
}

/** An app's tile: its initial, on a color of its own. */
function initial(name: string): HTMLElement {
  const tile = h("span", { class: "pl-tile pl-initial", "aria-hidden": "true" }, [...name.trim()][0]?.toUpperCase() ?? "?");
  const hue = [...name].reduce((sum, c) => (sum * 31 + c.codePointAt(0)!) % 360, 7);
  tile.style.setProperty("--hue", String(hue));
  return tile;
}

const tile = (item: Item) => (item.icon ? h("span", { class: "pl-tile", "aria-hidden": "true" }, icon(item.icon)) : initial(item.title));

const kbd = (text: string) => h("kbd", {}, text);

/** The command palette: one search for apps, files, the app's commands, system actions, a calculator, the web and a terminal. */
export function paletteView(root: HTMLElement, ctx: PaletteContext, recent: Recent = localRecent()): PopupView {
  const { palette: port, clipboard } = ctx.services;
  const apps = appsProvider(port, recent);
  const providers: Provider[] = [
    calcProvider((text) => clipboard.copy(text)),
    apps,
    commandsProvider(ctx, SELF, recent),
    systemProvider(port, () => ctx.options().confirm, recent),
    shellProvider(port),
    webProvider(port, () => ENGINES[ctx.options().engine] ?? ENGINES.duckduckgo!),
    filesProvider(port, () => ctx.options().files),
  ];

  let shown: Item[] = [];
  let index = 0;
  /** The query's version: results for an older one are dropped. */
  let version = 0;
  /** Whether the user moved the selection since typing, so late results don't take it away. */
  let moved = false;
  /** The item waiting for Enter again before an action that can't be undone. */
  let armed: string | null = null;
  let busy = false;

  const search = h("input", {
    class: "pk-search",
    type: "text",
    placeholder: "Search apps, files and commands…",
    autocomplete: "off",
    spellcheck: "false",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "pl-list",
    "aria-label": "Search apps, files and commands",
  });
  const mode = h("span", { class: "pl-mode" });
  const list = h("ul", { class: "pk-list pl-list", id: "pl-list", role: "listbox", "aria-label": "Results" });
  const empty = h("p", { class: "pk-empty" });
  const status = h("span", { class: "pl-status", role: "status" });
  const keys = h("span", { class: "pk-keys" });
  root.append(h("header", { class: "pk-head" }, icon(SEARCH, "icon pk-search-icon"), search, mode), list, empty, h("footer", { class: "pk-foot" }, status, keys));

  const selected = (): Item | undefined => shown[index];

  const drawKeys = () => {
    const item = selected();
    const parts: (Node | string)[] = [kbd("↑"), kbd("↓"), " "];
    if (item) parts.push(kbd("↵"), ` ${item.primary.label} `);
    if (item?.secondary) parts.push(kbd(isMac() ? "⌘" : "Ctrl"), kbd("↵"), ` ${item.secondary.label} `);
    if (item?.complete) parts.push(kbd("Tab"), " Open folder ");
    keys.replaceChildren(...parts, kbd("Esc"));
  };

  const select = (next: number) => {
    index = Math.max(0, Math.min(next, shown.length - 1));
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === index)));
    const active = list.children[index];
    active?.scrollIntoView({ block: "nearest" });
    if (active) search.setAttribute("aria-activedescendant", active.id);
    else search.removeAttribute("aria-activedescendant");
    drawKeys();
  };

  const row = (item: Item, i: number) => {
    const asking = armed === item.key && item.confirm;
    const meta = item.shortcut ? h("span", { class: "pl-keys" }, ...keycaps(item.shortcut).map(kbd)) : h("span", {}, KINDS[item.kind]);
    const li = h(
      "li",
      { id: `pl-${i}`, role: "option", "aria-selected": "false", "data-kind": item.kind },
      tile(item),
      h("span", { class: "pl-main" }, h("span", { class: "pl-title" }, ...highlight(item.title, item.hits)), h("span", { class: asking ? "pl-sub pl-ask" : "pl-sub" }, asking || item.subtitle)),
      h("span", { class: "pk-meta" }, meta),
    );
    li.addEventListener("mousemove", () => {
      if (index === i) return;
      moved = true;
      select(i);
    });
    li.addEventListener("click", (e) => void execute(item, e.ctrlKey || e.metaKey ? item.secondary : item.primary));
    return li;
  };

  const draw = (items: Item[], query: ReturnType<typeof parseQuery>) => {
    const keep = moved ? selected()?.key : undefined;
    shown = rank(items, recent);
    list.replaceChildren(...shown.map(row));
    empty.hidden = shown.length > 0;
    empty.textContent = query.mode === "all" && query.text ? "Nothing found." : EMPTY[query.mode];
    mode.textContent = MODES[query.mode] ?? "";
    mode.hidden = !mode.textContent;
    const kept = keep === undefined ? -1 : shown.findIndex((item) => item.key === keep);
    select(kept >= 0 ? kept : 0);
  };

  /** Searches every provider: what they know at once is drawn now, the rest as it arrives. */
  const update = () => {
    const v = ++version;
    const query = parseQuery(search.value);
    const found: Item[] = [];
    const late: Promise<readonly Item[]>[] = [];
    for (const provider of providers) {
      const result = provider.search(query);
      if (result instanceof Promise) late.push(result);
      else found.push(...result);
    }
    draw(found, query);
    for (const result of late) {
      void result.then((items) => {
        if (v !== version || !items.length) return;
        found.push(...items);
        draw(found, query);
      });
    }
  };

  const say = (text: string, problem = false) => {
    status.textContent = text;
    status.classList.toggle("pl-problem", problem);
  };

  async function execute(item: Item | undefined, action: Action | undefined): Promise<void> {
    if (!item || !action || busy) return;
    if (item.confirm && action === item.primary && armed !== item.key) {
      armed = item.key;
      list.children[index]?.replaceWith(row(item, index));
      select(index);
      return;
    }
    armed = null;
    busy = true;
    say("");
    try {
      recent.note(item.key);
      await action.run();
      if (action.closes !== false) ctx.close();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    } finally {
      busy = false;
    }
  }

  const disarm = () => {
    if (armed === null) return false;
    armed = null;
    list.replaceChildren(...shown.map(row));
    select(index);
    return true;
  };

  search.addEventListener("input", () => {
    moved = false;
    armed = null;
    say("");
    update();
  });
  search.addEventListener("keydown", (e) => {
    const item = selected();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      disarm();
      moved = true;
      select(index + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") void execute(item, (isMac() ? e.metaKey : e.ctrlKey) ? item?.secondary : item?.primary);
    else if (e.key === "Tab") {
      if (item?.complete) {
        search.value = item.complete;
        search.dispatchEvent(new Event("input"));
      }
    } else if (e.key === "Escape") {
      // Esc first drops a pending confirmation; the window closes on the next one.
      if (!disarm()) return;
    } else return;
    e.preventDefault();
  });

  return {
    show() {
      search.value = "";
      moved = false;
      armed = null;
      say("");
      search.focus();
      update();
      // The apps listed last time show at once; the fresh list replaces them when it arrives.
      void apps.refresh().then(update);
    },
  };
}
