import { h } from "../../sdk/dom";
import { defineStyle } from "../../sdk/style";
import { progressOf } from "./lead";

/** Height of the Sliver at the Normal size, in px. */
export const SLIVER_HEIGHT = 6;

/**
 * A thin strip under the top edge, without text: a line shows progress (the timer, a level) in the
 * tint of what is in focus, or pulses full while music plays; the strip turns orange when
 * something asks for attention, and dots at its end show the mic or camera in use.
 */
export const sliver = defineStyle({
  id: "sliver",
  label: "Sliver",
  description: "A thin strip without text: progress, alerts and the mic in color.",
  widens: false,
  // Behind a hardware notch a strip wouldn't show: there it stays a pill.
  size: (pill) => (pill.hasNotch ? pill : { width: Math.round(pill.width * 0.7), height: Math.max(3, Math.round(SLIVER_HEIGHT * pill.scale)) }),
  mount(root) {
    root.classList.add("sliver");
    const fill = h("i");
    const line = h("span", { class: "sliver-line" }, fill);
    const mic = h("i", { class: "sliver-dot", "data-kind": "mic" });
    const camera = h("i", { class: "sliver-dot", "data-kind": "camera" });
    const dots = h("span", { class: "sliver-dots" }, camera, mic);
    root.append(h("span", { class: "sliver-in", "aria-hidden": "true" }, line, dots));
    return {
      draw(folded) {
        const marks = [folded.left?.mark, folded.right?.mark];
        const p = progressOf(folded);
        const playing = p === undefined && marks.includes("eq");
        root.dataset.alert = String(folded.alert);
        root.dataset.playing = String(playing);
        line.hidden = p === undefined && !playing;
        fill.style.setProperty("--p", String(playing ? 1 : (p ?? 0)));
        mic.hidden = !marks.includes("mic");
        camera.hidden = !marks.includes("camera");
      },
    };
  },
});
