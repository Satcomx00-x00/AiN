import { sparkline } from "./chart";
import { EASE_OUT, h, icon, reducedMotion, roll, svg } from "./dom";
import type { Glance } from "./plugin";

const SPARK_SLOTS = 12;

export interface GlanceSlot {
  readonly el: HTMLElement;
  /** `source` identifies who is speaking; a new source pops in instead of rolling characters. */
  draw(g: Glance | null, source?: string): void;
}

/** One glance spot on the collapsed pill: optional art, icon, mark, ring, sparkline or level bar, then text. */
export function glanceSlot(): GlanceSlot {
  const art = h("img", { class: "g-art", alt: "" });
  const ico = h("span", { class: "g-icon", "aria-hidden": "true" });
  let shownIcon: string | undefined;
  const mark = h("span", { class: "mark", "aria-hidden": "true" }, h("i"), h("i"), h("i"));
  const ring = svg("0 0 16 16", `<circle class="track" cx="8" cy="8" r="6" pathLength="100"/><circle class="fill" cx="8" cy="8" r="6" pathLength="100"/>`, "mini-ring");
  const spark = svg("0 0 24 12", "<polyline/>", "mini-spark");
  spark.setAttribute("preserveAspectRatio", "none");
  const line = spark.querySelector("polyline");
  const bar = h("span", { class: "g-bar", "aria-hidden": "true" }, h("i"));
  const text = h("span", { class: "g-text" });
  const el = h("span", { class: "g" }, art, ico, mark, ring, spark, bar, text);
  let shownSource: string | undefined;

  return {
    el,
    draw(g, source) {
      const switched = source !== shownSource;
      shownSource = source;
      if (switched) delete text.dataset.text; // a new speaker: set text at once rather than rolling it
      roll(text, g?.text ?? "");
      el.dataset.tone = g?.tone ?? "";
      mark.dataset.kind = g?.mark ?? "";
      art.hidden = !g?.art;
      if (g?.art && art.getAttribute("src") !== g.art) art.src = g.art;
      ico.hidden = !g?.icon;
      if (g?.icon && g.icon !== shownIcon) ico.replaceChildren(icon(g.icon));
      shownIcon = g?.icon;
      ring.style.display = g?.progress === undefined ? "none" : "";
      ring.style.setProperty("--p", String(g?.progress ?? 0));
      spark.style.display = g?.spark ? "" : "none";
      if (g?.spark) line?.setAttribute("points", sparkline(g.spark, 24, 12, 100, SPARK_SLOTS));
      bar.hidden = g?.level === undefined;
      bar.style.setProperty("--p", String(g?.level ?? 0));
      if (switched && g && !reducedMotion())
        el.animate(
          [
            { opacity: 0, transform: "scale(0.82)", filter: "blur(4px)" },
            { opacity: 1, transform: "none", filter: "none" },
          ],
          { duration: 420, easing: EASE_OUT },
        );
    },
  };
}
