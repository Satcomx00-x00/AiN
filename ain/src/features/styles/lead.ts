import type { Glance } from "../../sdk/plugin";
import type { Folded } from "../../sdk/style";

export interface Speaking {
  readonly glance: Glance;
  readonly from?: string | undefined;
}

/** Both spots, right first: by default the right one holds what changes (music, the timer…). */
const spots = ({ left, right, leftFrom, rightFrom }: Folded): Speaking[] => [
  ...(right ? [{ glance: right, from: rightFrom }] : []),
  ...(left ? [{ glance: left, from: leftFrom }] : []),
];

/** The glance that matters most, for styles with room for one: an alert, then a live activity, then the right spot, then the left. */
export function lead(folded: Folded): Speaking | null {
  const all = spots(folded);
  return all.find((s) => s.glance.tone === "alert") ?? all.find((s) => s.glance.wide) ?? all[0] ?? null;
}

/** A glance using the mic or camera: shown over anything else, as phones do. */
export const privacy = (folded: Folded): Speaking | null => spots(folded).find((s) => s.glance.mark === "mic" || s.glance.mark === "camera") ?? null;

/** Progress (0–1) from the most important glance that has some: a ring, else a level bar. */
export function progressOf(folded: Folded): number | undefined {
  const all = spots(folded);
  const first = lead(folded);
  const ordered = first ? [first, ...all.filter((s) => s !== first)] : all;
  for (const { glance } of ordered) {
    const p = glance.progress ?? glance.level;
    if (p !== undefined) return Math.min(1, Math.max(0, p));
  }
  return undefined;
}
