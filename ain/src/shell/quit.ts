import { button, icon } from "../sdk/dom";

/** Lucide's "power" icon (ISC), drawn on a 24 grid and scaled into our 16 px icons. */
export const POWER = `<g transform="scale(0.6667)" stroke-width="2.25"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></g>`;

/**
 * An icon button that acts on a second click within `ms`: the first click only arms it (and says
 * so), so a stray click next to it can't do something as final as quitting.
 */
export function armedButton(markup: string, onConfirm: () => void, labels: { label: string; armed: string }, cls = "", ms = 3000): HTMLButtonElement {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (armed: boolean) => {
    el.dataset.armed = String(armed);
    const text = armed ? labels.armed : labels.label;
    el.setAttribute("aria-label", text);
    el.title = text;
  };
  const el = button(icon(markup), () => {
    clearTimeout(timer);
    if (el.dataset.armed === "true") {
      set(false);
      onConfirm();
      return;
    }
    set(true);
    timer = setTimeout(() => set(false), ms);
  }, { class: cls });
  set(false);
  return el;
}
