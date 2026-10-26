/** Finding a setting by what it's called or what it does, wherever it lives in Settings. */

/** A setting to find: its name and hint, where it is (shown as a path), and where to go for it. */
export type SearchEntry = {
  readonly label: string;
  readonly hint?: string | undefined;
  /** Where it lives, as the user would follow it: "Widgets › Dictation". */
  readonly where: string;
  /** The place to open: a section ("general") or a widget ("widgets:dictation"). */
  readonly target: string;
  /** The row to bring into view there, by its label; none for a whole page. */
  readonly field?: string | undefined;
  /** Other words it's found by. */
  readonly keywords?: string | undefined;
};

/** At most this many results: past that, the words typed are too vague to scan anyway. */
export const MAX_RESULTS = 40;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * The entries with every word of `query` in their name, hint, place or keywords, best first: names
 * that start with the query, then names that hold it, then the rest, each in their given order.
 */
export function search(query: string, entries: readonly SearchEntry[]): SearchEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const whole = fold(query.trim());
  const rank = (e: SearchEntry) => {
    const label = fold(e.label);
    return label.startsWith(whole) ? 0 : label.includes(whole) ? 1 : 2;
  };
  return entries
    .filter((e) => {
      const text = fold(`${e.label} ${e.hint ?? ""} ${e.where} ${e.keywords ?? ""}`);
      return words.every((w) => text.includes(w));
    })
    .map((e, at) => ({ e, at, rank: rank(e) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .slice(0, MAX_RESULTS)
    .map(({ e }) => e);
}
