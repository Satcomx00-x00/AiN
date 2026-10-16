import { glanceSlot } from "../../sdk/glance";
import { defineStyle } from "../../sdk/style";
import { lead } from "./lead";

/** A narrower pill with one glance in the middle: whatever matters most right now. */
export const solo = defineStyle({
  id: "solo",
  label: "Solo",
  description: "One glance in the middle: an alert, music, or the right spot.",
  size: (pill) => (pill.hasNotch ? pill : { width: Math.round(pill.width * 0.7), height: pill.height }),
  mount(root) {
    root.classList.add("solo");
    const slot = glanceSlot();
    root.append(slot.el);
    return {
      draw(folded) {
        const shown = lead(folded);
        slot.draw(shown?.glance ?? null, shown?.from);
      },
    };
  },
});
