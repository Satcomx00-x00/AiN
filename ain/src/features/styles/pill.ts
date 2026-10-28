import { h } from "../../sdk/dom";
import { type GlanceSlot, glanceSlot } from "../../sdk/glance";
import type { Glance } from "../../sdk/plugin";
import { type Folded, type Spoken, type StyleView, defineStyle } from "../../sdk/style";

/** One end of the pill: as many glances side by side as the spot has to show, in priority order. */
function end(cls: string) {
  const el = h("span", { class: `g-end ${cls}` });
  const slots: GlanceSlot[] = [];
  return {
    el,
    draw(all: readonly Spoken[]) {
      while (slots.length < Math.max(1, all.length)) {
        const slot = glanceSlot();
        slots.push(slot);
        el.append(slot.el);
      }
      slots.forEach((slot, i) => {
        const said = all[i];
        slot.el.hidden = i > 0 && !said;
        slot.draw(said?.glance ?? null, said?.from);
      });
    },
  };
}

/** What a spot shows, for styles drawn before `leftAll`/`rightAll` existed too. */
const allOf = (all: readonly Spoken[] | undefined, one: Glance | null, from: string | undefined): readonly Spoken[] =>
  all ?? (one ? [{ glance: one, from: from ?? "" }] : []);

/** Glances at each end of the pill: what the plugins in Settings → Pill's two spots say. */
function glances(root: HTMLElement): StyleView {
  const left = end("left");
  const right = end("right");
  root.append(left.el, right.el);
  return {
    draw({ left: l, right: r, leftFrom, rightFrom, leftAll, rightAll }: Folded) {
      left.draw(allOf(leftAll, l, leftFrom));
      right.draw(allOf(rightAll, r, rightFrom));
    },
  };
}

/** The pill, always on screen. */
export const pill = defineStyle({ id: "pill", label: "Pill", description: "Glances at each end.", mount: glances });

/** The same pill, kept out of sight until the cursor rests at the top center of the screen. */
export const hidden = defineStyle({
  id: "hidden",
  label: "Hidden",
  description: "The Pill, shown only when the cursor rests on its spot.",
  hidden: true,
  mount: glances,
});
