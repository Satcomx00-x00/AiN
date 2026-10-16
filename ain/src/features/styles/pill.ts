import { glanceSlot } from "../../sdk/glance";
import { type Folded, type StyleView, defineStyle } from "../../sdk/style";

/** One glance at each end of the pill: what the plugins in Settings → Layout's two spots say. */
function glances(root: HTMLElement): StyleView {
  const left = glanceSlot();
  const right = glanceSlot();
  root.append(left.el, right.el);
  return {
    draw({ left: l, right: r, leftFrom, rightFrom }: Folded) {
      left.draw(l, leftFrom);
      right.draw(r, rightFrom);
    },
  };
}

/** The pill, always on screen. */
export const pill = defineStyle({ id: "pill", label: "Pill", description: "A glance at each end.", mount: glances });

/** The same pill, kept out of sight until the cursor rests at the top center of the screen. */
export const hidden = defineStyle({
  id: "hidden",
  label: "Hidden",
  description: "The Pill, shown only when the cursor rests on its spot.",
  hidden: true,
  mount: glances,
});
