import type { Recent } from "./recent";

/** What a result is, for its icon and its label. */
export type Kind = "app" | "file" | "folder" | "calc" | "web" | "link" | "shell" | "system" | "command";

export interface Action {
  /** What the key hint says it does, e.g. "Open". */
  readonly label: string;
  readonly run: () => Promise<void>;
  /** Whether the palette closes once it ran (the default), or the action took care of the window itself. */
  readonly closes?: boolean;
}

/** One result row. */
export interface Item {
  /** The same across searches: what the palette remembers uses by. */
  readonly key: string;
  readonly kind: Kind;
  readonly title: string;
  readonly subtitle: string;
  /** Characters of the title that matched the query, to highlight. */
  readonly hits: readonly number[];
  /** How good a result it is; the palette adds what it remembers of its uses. */
  readonly score: number;
  /** On Enter or a click. */
  readonly primary: Action;
  /** On Ctrl+Enter (Cmd+Enter on macOS), when there is one. */
  readonly secondary?: Action;
  /** Asked before `primary` runs, for what can't be undone: Enter must be pressed again. */
  readonly confirm?: string;
  /** Inner SVG markup of its 16×16 icon; apps show their initial instead. */
  readonly icon?: string;
  /** A shortcut to show as keycaps. */
  readonly shortcut?: string;
  /** What Tab turns the query into: a folder's path, to browse into it. */
  readonly complete?: string;
}

export type Mode = "all" | "shell" | "web" | "calc" | "path";

/** What was typed: a prefix picks a mode (`>` a command line, `?` the web, `=` a calculation), a path browses. */
export interface Query {
  readonly mode: Mode;
  readonly text: string;
}

const PATH = /^(~(?:[\\/]|$)|\/|[a-z]:[\\/]|\\\\)/i;
const PREFIXES: Readonly<Record<string, Mode>> = { ">": "shell", "?": "web", "=": "calc" };

export function parseQuery(raw: string): Query {
  const text = raw.trimStart();
  const mode = PREFIXES[text[0] ?? ""];
  if (mode) return { mode, text: text.slice(1).trim() };
  if (PATH.test(text)) return { mode: "path", text };
  return { mode: "all", text: text.trim() };
}

/** A source of results. It may answer late: results arrive when ready, unless the query changed. */
export interface Provider {
  search(query: Query): readonly Item[] | Promise<readonly Item[]>;
}

export const MAX_SHOWN = 40;

/** Items best first, what was used often and lately lifted, each key once. */
export function rank(items: readonly Item[], recent: Recent): Item[] {
  const seen = new Set<string>();
  return items
    .map((item) => ({ item, score: item.score + recent.boost(item.key) }))
    .sort((a, b) => b.score - a.score)
    .flatMap(({ item }) => (seen.has(item.key) ? [] : (seen.add(item.key), [item])))
    .slice(0, MAX_SHOWN);
}
