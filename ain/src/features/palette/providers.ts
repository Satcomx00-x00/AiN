import { isWindows } from "../../sdk/platform";
import type { CommandInfo } from "../../sdk/plugin";
import { calculate, plain, pretty } from "./calc";
import { best, fuzzy } from "./fuzzy";
import type { Action, Item, Provider, Query } from "./items";
import type { Recent } from "./recent";
import type { App, Hit, PalettePort, SystemAction } from "./service";

export const ICONS = {
  file: `<path d="M4 1.75h5l3 3v9.5H4z"/><path d="M9 1.75v3h3"/>`,
  folder: `<path d="M1.75 4.25a1 1 0 0 1 1-1h3.5l1.5 1.5h5.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z"/>`,
  calc: `<rect x="3" y="1.75" width="10" height="12.5" rx="1.75"/><path d="M5.5 5h5M5.5 8.5h1M9.5 8.5h1M5.5 11h1M9.5 11h1"/>`,
  web: `<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5M8 1.75c-3 3.5-3 9 0 12.5M8 1.75c3 3.5 3 9 0 12.5"/>`,
  link: `<path d="M6.75 9.25a3 3 0 0 0 4.25 0l2-2a3 3 0 0 0-4.25-4.25l-.75.75"/><path d="M9.25 6.75a3 3 0 0 0-4.25 0l-2 2a3 3 0 0 0 4.25 4.25l.75-.75"/>`,
  shell: `<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="M4.5 6.25 6.5 8l-2 1.75M8 10h3.5"/>`,
  power: `<path d="M8 1.75v5.5"/><path d="M4.75 3.75a5.25 5.25 0 1 0 6.5 0"/>`,
  lock: `<rect x="3.25" y="7" width="9.5" height="7" rx="1.5"/><path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2"/>`,
  moon: `<path d="M13.25 9.5A5.75 5.75 0 1 1 6.5 2.75a4.5 4.5 0 0 0 6.75 6.75z"/>`,
  restart: `<path d="M13.25 8a5.25 5.25 0 1 1-1.75-3.9"/><path d="M11.75 1.5v2.75H9"/>`,
  signOut: `<path d="M6.5 2.75h-3a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1h3M10 5l3 3-3 3M13 8H6.25"/>`,
  trash: `<path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.75 9.5h6.5l.75-9.5"/>`,
  settings: `<circle cx="8" cy="8" r="2.25"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>`,
} as const;

/** Lists what a query shows when it's empty: only what was used before, most recent first. */
const remembered = (key: string, recent: Recent) => recent.boost(key) > 0;

/** Scores `title` (and the hidden `words`) against the query; on an empty one, only remembered items show. */
function matched(text: string, key: string, recent: Recent, title: string, ...words: string[]): { score: number; hits: readonly number[] } | null {
  if (!text) return remembered(key, recent) ? { score: 0, hits: [] } : null;
  return best(text, title, ...words);
}

/** Installed apps; `refresh` lists them again (each time the palette opens). */
export function appsProvider(port: PalettePort, recent: Recent): Provider & { refresh(): Promise<void> } {
  let apps: App[] = [];
  return {
    async refresh() {
      apps = await port.apps().catch(() => apps);
    },
    search: ({ mode, text }) =>
      mode !== "all"
        ? []
        : apps.flatMap((app): Item[] => {
            const key = `app:${app.id}`;
            const m = matched(text, key, recent, app.name, app.keywords);
            if (!m) return [];
            return [{ key, kind: "app", title: app.name, subtitle: app.detail, hits: m.hits, score: m.score, primary: { label: "Open", run: () => port.launch(app.id) } }];
          }),
  };
}

/** What the palette needs of the popup to list and run the app's own commands. */
export interface Host {
  commands(): readonly CommandInfo[];
  run(id: string): Promise<void>;
  openSettings(): Promise<void>;
  quit(): Promise<void>;
}

/** The app's own commands (every plugin's, but the palette's), its Settings, and quitting it. */
export function commandsProvider(host: Host, self: string, recent: Recent): Provider {
  return {
    search: ({ mode, text }) => {
      if (mode !== "all") return [];
      const own: Item[] = host
        .commands()
        .filter((c) => c.id !== self)
        .map((c) => ({
          key: `command:${c.id}`,
          kind: "command",
          title: c.label,
          subtitle: c.description,
          hits: [],
          score: 0,
          icon: c.icon,
          ...(c.shortcut ? { shortcut: c.shortcut } : {}),
          primary: { label: "Run", run: () => host.run(c.id), closes: false },
        }));
      const app: Item[] = [
        { key: "ain:settings", kind: "command", title: "AiN settings", subtitle: "Widgets, shortcuts, appearance", hits: [], score: 0, icon: ICONS.settings, primary: { label: "Open", run: () => host.openSettings() } },
        { key: "ain:quit", kind: "command", title: "Quit AiN", subtitle: "Close the island and everything it runs", hits: [], score: 0, icon: ICONS.power, primary: { label: "Quit", run: () => host.quit() } },
      ];
      return [...own, ...app].flatMap((item): Item[] => {
        const m = matched(text, item.key, recent, item.title, item.subtitle, "ain");
        return m ? [{ ...item, hits: m.hits, score: m.score }] : [];
      });
    },
  };
}

interface SystemEntry {
  readonly action: SystemAction;
  readonly title: string;
  readonly words: string;
  readonly icon: string;
  /** Asked before, when the settings say so: it ends what the user is doing. */
  readonly final?: string;
}

/** What the trash is called on this system. */
export const trashTitle = (windows = isWindows()): string => (windows ? "Empty the Recycle Bin" : "Empty the Trash");

export const SYSTEM: readonly SystemEntry[] = [
  { action: "lock", title: "Lock", words: "lock screen", icon: ICONS.lock },
  { action: "sleep", title: "Sleep", words: "suspend standby", icon: ICONS.moon },
  { action: "signOut", title: "Sign out", words: "log out logout log off logoff", icon: ICONS.signOut, final: "sign out" },
  { action: "restart", title: "Restart", words: "reboot", icon: ICONS.restart, final: "restart" },
  { action: "shutDown", title: "Shut down", words: "power off poweroff turn off halt", icon: ICONS.power, final: "shut down" },
  { action: "emptyTrash", title: trashTitle(), words: "trash recycle bin delete", icon: ICONS.trash, final: "empty it" },
];

/** Lock, sleep, sign out, restart, shut down, empty the trash; `confirm` says whether the final ones ask first. */
export function systemProvider(port: PalettePort, confirm: () => boolean, recent: Recent): Provider {
  return {
    search: ({ mode, text }) =>
      mode !== "all"
        ? []
        : SYSTEM.flatMap((entry): Item[] => {
            const key = `system:${entry.action}`;
            const m = matched(text, key, recent, entry.title, entry.words);
            if (!m) return [];
            const item: Item = { key, kind: "system", title: entry.title, subtitle: "System", hits: m.hits, score: m.score, icon: entry.icon, primary: { label: entry.title, run: () => port.system(entry.action) } };
            return [entry.final && confirm() ? { ...item, confirm: `Press Enter again to ${entry.final}` } : item];
          }),
  };
}

/** A calculation's result, first; Enter copies it. */
export function calcProvider(copy: (text: string) => Promise<void>): Provider {
  return {
    search: ({ mode, text }) => {
      if (mode !== "all" && mode !== "calc") return [];
      const value = calculate(text);
      if (value === null) return [];
      return [{ key: "calc", kind: "calc", title: `= ${pretty(value)}`, subtitle: text, hits: [], score: 10_000, icon: ICONS.calc, primary: { label: "Copy", run: () => copy(plain(value)) } }];
    },
  };
}

export interface Engine {
  readonly label: string;
  /** The search page, the query appended. */
  readonly url: string;
}

export const ENGINES: Readonly<Record<string, Engine>> = {
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  google: { label: "Google", url: "https://www.google.com/search?q=" },
  bing: { label: "Bing", url: "https://www.bing.com/search?q=" },
  brave: { label: "Brave Search", url: "https://search.brave.com/search?q=" },
  qwant: { label: "Qwant", url: "https://www.qwant.com/?q=" },
  ecosia: { label: "Ecosia", url: "https://www.ecosia.org/search?q=" },
  startpage: { label: "Startpage", url: "https://www.startpage.com/do/search?q=" },
};

const ADDRESS = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.(\p{L}{2,})(:\d{1,5})?([/?#]\S*)?$/u;
/** Endings that make "report.pdf" a file name rather than an address, though some are domains too. */
const FILE_ENDINGS = new Set("app csv doc docx exe gif heic jpeg jpg js json md mov mp3 mp4 pdf png ppt pptx py rs svg ts txt webp xls xlsx zip".split(" "));

/** The https link `text` is: as typed, or a bare address ("example.com/page"); null otherwise. */
export function asLink(text: string): { url: string; typed: boolean } | null {
  if (/^https:\/\/\S+$/i.test(text)) return { url: text, typed: true };
  const ending = ADDRESS.exec(text)?.[2]?.toLowerCase();
  return ending && !FILE_ENDINGS.has(ending) ? { url: `https://${text}`, typed: false } : null;
}

/** A link typed, and a web search: on `?`, or as the last resort for any text. */
export function webProvider(port: PalettePort, engine: () => Engine): Provider {
  return {
    search: ({ mode, text }) => {
      if (!text || (mode !== "all" && mode !== "web")) return [];
      const { label, url } = engine();
      const search: Item = {
        key: "web",
        kind: "web",
        title: `Search ${label} for “${text}”`,
        subtitle: "Web",
        hits: [],
        score: mode === "web" ? 10_000 : 1,
        icon: ICONS.web,
        primary: { label: "Search", run: () => port.openUrl(url + encodeURIComponent(text)) },
      };
      const link = mode === "all" ? asLink(text) : null;
      if (!link) return [search];
      const open: Item = {
        key: `link:${link.url}`,
        kind: "link",
        title: link.url.replace(/^https:\/\//, ""),
        subtitle: "Open in the browser",
        hits: [],
        // A bare address could still be a name being typed: above the files, below a good match.
        score: link.typed ? 9_000 : 450,
        icon: ICONS.link,
        primary: { label: "Open", run: () => port.openUrl(link.url) },
      };
      return [open, search];
    },
  };
}

/** A command line after `>`, run in a terminal. */
export function shellProvider(port: PalettePort): Provider {
  return {
    search: ({ mode, text }) =>
      mode !== "shell" || !text
        ? []
        : [{ key: `shell:${text}`, kind: "shell", title: text, subtitle: "Run in a new terminal window", hits: [], score: 10_000, icon: ICONS.shell, primary: { label: "Run", run: () => port.run(text) } }],
  };
}

/** The separator a path uses: a backslash for Windows paths. */
const separator = (path: string) => (/^[a-z]:\\|^\\\\/i.test(path) ? "\\" : "/");

/** What showing a file in its folder is called on this system. */

function fileItem(port: PalettePort, hit: Hit, text: string, score: number): Item {
  const reveal: Action = { label: "Show in folder", run: () => port.reveal(hit.path) };
  return {
    key: `file:${hit.path}`,
    kind: hit.dir ? "folder" : "file",
    title: hit.name,
    subtitle: hit.folder,
    hits: fuzzy(text, hit.name)?.hits ?? [],
    score,
    icon: hit.dir ? ICONS.folder : ICONS.file,
    primary: { label: "Open", run: () => port.open(hit.path) },
    secondary: reveal,
    ...(hit.dir ? { complete: hit.path + separator(hit.path) } : {}),
  };
}

const FILES_SHOWN = 12;
const BROWSED = 30;

/**
 * Files by name (from two characters typed, while `enabled`), below the apps and commands that
 * match well; a typed path lists its folder instead.
 */
export function filesProvider(port: PalettePort, enabled: () => boolean): Provider {
  return {
    async search({ mode, text }: Query) {
      if (mode === "path") {
        const hits = await port.browse(text, BROWSED).catch(() => []);
        return hits.map((hit, i) => fileItem(port, hit, text.split(/[\\/]/).at(-1)!, 5_000 - i));
      }
      if (mode !== "all" || text.length < 2 || !enabled()) return [];
      const hits = await port.files(text, FILES_SHOWN).catch(() => []);
      return hits.map((hit, i) => fileItem(port, hit, text, 400 - i * 10));
    },
  };
}
