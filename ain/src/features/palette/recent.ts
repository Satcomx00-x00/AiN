/** What the palette remembers about what was run from it, so the usual picks come first. */
export interface Recent {
  /** How much to lift an item: more for one used often, and lately. */
  boost(key: string): number;
  /** Records that `key` was just run. */
  note(key: string): void;
  /** The keys run, most recent first. */
  keys(): string[];
}

type Uses = Record<string, { readonly n: number; readonly at: number }>;

const KEY = "palette.recent";
const KEEP = 200;
const DAY = 86_400_000;

/**
 * Uses kept in `storage` (the popup's local storage), on this computer only. Storage can be
 * missing or refuse writes (private mode, cleared site data): the palette then just doesn't learn.
 */
export function recentIn(storage: Pick<Storage, "getItem" | "setItem"> | null, now: () => number = Date.now): Recent {
  let uses: Uses = {};
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    if (raw && typeof raw === "object") uses = raw as Uses;
  } catch {
    uses = {};
  }
  const save = () => {
    try {
      storage?.setItem(KEY, JSON.stringify(uses));
    } catch {
      // Full or refused: the palette works the same, it just forgets.
    }
  };
  return {
    boost(key) {
      const use = uses[key];
      if (!use || typeof use.n !== "number" || typeof use.at !== "number") return 0;
      const days = Math.max(0, now() - use.at) / DAY;
      return Math.round(Math.min(use.n, 20) * 15 + 150 / (1 + days));
    },
    note(key) {
      uses = { ...uses, [key]: { n: (uses[key]?.n ?? 0) + 1, at: now() } };
      const kept = Object.entries(uses).sort(([, a], [, b]) => b.at - a.at);
      if (kept.length > KEEP) uses = Object.fromEntries(kept.slice(0, KEEP));
      save();
    },
    keys: () =>
      Object.entries(uses)
        .sort(([, a], [, b]) => b.at - a.at)
        .map(([key]) => key),
  };
}

/** The popup window's own local storage, when it can be read. */
export function localRecent(): Recent {
  let storage: Storage | null = null;
  try {
    storage = globalThis.localStorage ?? null;
  } catch {
    storage = null;
  }
  return recentIn(storage);
}
