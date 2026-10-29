/** How a query matched a text: the higher the better, and which characters to highlight. */
export interface Match {
  readonly score: number;
  readonly hits: readonly number[];
}

const range = (from: number, length: number): number[] => Array.from({ length }, (_, i) => from + i);

/** Whether `text[i]` starts a word: the first character, one after a separator, or a capital after a small letter. */
export function startsWord(text: string, i: number): boolean {
  const [before, at] = [text[i - 1], text[i]];
  if (before === undefined || at === undefined) return i === 0;
  return !/[\p{L}\p{N}]/u.test(before) || (/\p{Ll}/u.test(before) && /\p{Lu}/u.test(at));
}

/** The query's characters on the starts of the text's words, in order ("vsc" in "Visual Studio Code"). */
function acronym(text: string, query: string): number[] | null {
  const lower = text.toLowerCase();
  const hits: number[] = [];
  let from = 0;
  for (const c of query) {
    let i = from;
    while (i < lower.length && !(lower[i] === c && startsWord(text, i))) i++;
    if (i >= lower.length) return null;
    hits.push(i);
    from = i + 1;
  }
  return hits;
}

/** The query's characters in order anywhere in the text, each as early as it comes. */
function subsequence(lower: string, query: string): number[] | null {
  const hits: number[] = [];
  let from = 0;
  for (const c of query) {
    const i = lower.indexOf(c, from);
    if (i < 0) return null;
    hits.push(i);
    from = i + 1;
  }
  return hits;
}

/**
 * How well `query` matches `text`, case-insensitively, or null when it doesn't: best as a piece of
 * the text (at its start, then at a word's), then with every word somewhere, then as the starts of
 * its words, then as letters in order. Shorter texts win ties.
 */
export function fuzzy(query: string, text: string): Match | null {
  const q = query.toLowerCase().trim().replace(/\s+/g, " ");
  if (!q || !text) return null;
  const lower = text.toLowerCase();
  const short = -Math.min(text.length, 100);
  const at = lower.indexOf(q);
  if (at >= 0) return { score: 1000 + (at === 0 ? 300 : startsWord(text, at) ? 150 : 0) + short, hits: range(at, q.length) };
  const words = q.split(" ");
  if (words.length > 1) {
    const found = words.map((w) => lower.indexOf(w));
    if (found.every((i) => i >= 0)) return { score: 700 + short, hits: [...new Set(found.flatMap((i, n) => range(i, words[n]!.length)))].sort((a, b) => a - b) };
  }
  const compact = q.replaceAll(" ", "");
  const initials = acronym(text, compact);
  if (initials) return { score: 600 + short, hits: initials };
  const loose = subsequence(lower, compact);
  if (!loose) return null;
  // Letters close together count more than letters spread out.
  const spread = loose[loose.length - 1]! - loose[0]! - compact.length;
  return { score: 300 - Math.min(spread * 4, 200) + short, hits: loose };
}

/** The best of `query` matched against `texts`, the first text's hits kept for highlighting. */
export function best(query: string, title: string, ...others: readonly string[]): Match | null {
  const main = fuzzy(query, title);
  const rest = others.map((t) => fuzzy(query, t)).filter((m): m is Match => m !== null);
  // A match on what is shown beats one on hidden keywords.
  const other = rest.reduce<number>((top, m) => Math.max(top, m.score - 150), -Infinity);
  if (!main && other === -Infinity) return null;
  return main && main.score >= other ? main : { score: other, hits: main?.hits ?? [] };
}
