import type { Glance, Mounted } from "./plugin";

/** Where every plugin goes. Ids refer to `Plugin.id`; plugins not listed anywhere are not loaded. */
export interface Layout {
  /** Spots on the collapsed pill. Each is a priority list: the first plugin with something to say wins. */
  readonly glance: { readonly left: readonly string[]; readonly right: readonly string[] };
  /** Tabs of the open pill, in order. */
  readonly tabs: readonly string[];
}

export interface Placement {
  readonly left: readonly Mounted[];
  readonly right: readonly Mounted[];
  readonly tabs: readonly Mounted[];
}

/** Every id the layout mentions, i.e. the plugins that need to be set up. */
export const placedIds = (layout: Layout): Set<string> =>
  new Set([...layout.glance.left, ...layout.glance.right, ...layout.tabs]);

/** Resolves layout ids to mounted plugins, skipping (and reporting) anything that can't go where it's placed. */
export function place(mounted: ReadonlyMap<string, Mounted>, layout: Layout): { placement: Placement; problems: string[] } {
  const problems: string[] = [];
  const resolve = (ids: readonly string[], spot: string, has: (m: Mounted) => boolean) =>
    ids.flatMap((id) => {
      const m = mounted.get(id);
      if (!m) problems.push(`${spot}: unknown plugin "${id}"`);
      else if (!has(m)) problems.push(`${spot}: "${id}" has nothing to show there`);
      else return [m];
      return [];
    });
  const glance = (m: Mounted) => m.widget.glance !== undefined;
  const placement = {
    left: resolve(layout.glance.left, "glance.left", glance),
    right: resolve(layout.glance.right, "glance.right", glance),
    tabs: resolve(layout.tabs, "tabs", (m) => m.widget.panel !== undefined),
  };
  return { placement, problems };
}

export interface Shown {
  readonly from: Mounted;
  readonly glance: Glance;
}

/** The first plugin in a priority list that has something to say, and what it says. */
export const pickFrom = (spot: readonly Mounted[], now: number): Shown | null => {
  for (const from of spot) {
    const glance = from.widget.glance?.(now);
    if (glance) return { from, glance };
  }
  return null;
};

export const pick = (spot: readonly Mounted[], now: number): Glance | null => pickFrom(spot, now)?.glance ?? null;
