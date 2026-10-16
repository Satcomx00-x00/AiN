import { glanceSlot } from "../../sdk/glance";
import type { Glance } from "../../sdk/plugin";
import { defineStyle } from "../../sdk/style";
import { lead, privacy } from "./lead";

/** The Stub's size at the Normal size, in px. */
export const STUB = { width: 56, height: 14 } as const;

/**
 * The one mark a glance comes down to on the Stub, or null when it has none (plain text, like the
 * clock): the mic or camera dot, the recording dot, a ring for progress or a level, the music
 * bars. Something asking for attention without a mark shows as a dot.
 */
export function markOf(g: Glance): Glance | null {
  const tone = g.tone ? { tone: g.tone } : {};
  if (g.mark && g.mark !== "eq") return { text: "", mark: g.mark, ...tone };
  const p = g.progress ?? g.level;
  if (p !== undefined) return { text: "", progress: p, ...tone };
  if (g.mark === "eq") return { text: "", mark: "eq", ...tone };
  if (g.tone === "alert") return { text: "", mark: "rec", tone: "alert" };
  return null;
}

/** A small tab with a single mark in it; the mic and camera come first, as on phones. */
export const stub = defineStyle({
  id: "stub",
  label: "Stub",
  description: "A small tab with one mark: music bars, a ring, a dot.",
  widens: false,
  // Behind a hardware notch a tab wouldn't show: there it stays a pill.
  size: (pill) =>
    pill.hasNotch ? pill : { width: Math.round(STUB.width * pill.scale), height: Math.max(6, Math.round(STUB.height * pill.scale)) },
  mount(root) {
    root.classList.add("stub");
    const slot = glanceSlot();
    root.append(slot.el);
    return {
      draw(folded) {
        const shown = privacy(folded) ?? lead(folded);
        const mark = shown && markOf(shown.glance);
        slot.draw(mark, mark ? shown.from : undefined);
      },
    };
  },
});
