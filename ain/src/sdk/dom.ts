export const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
/** Overshoots slightly, then settles. */
export const SPRING = "cubic-bezier(0.34, 1.4, 0.64, 1)";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

export const button = (label: Node | string, onClick: () => void, attrs: Record<string, string> = {}) => {
  const b = h("button", { type: "button", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
};

/** Inline SVG from static, trusted markup only. */
export function svg(viewBox: string, markup: string, cls = ""): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("aria-hidden", "true");
  if (cls) el.setAttribute("class", cls);
  el.innerHTML = markup;
  return el;
}

export const icon = (markup: string, cls = "icon") => svg("0 0 16 16", markup, cls);

/** True when a computed `transition-duration` list will actually animate. */
export const animates = (transitionDuration: string) =>
  transitionDuration.split(",").some((d) => parseFloat(d) > 0);

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Sets text, sliding in only the characters that changed. */
export function roll(el: HTMLElement, text: string): void {
  const prev = el.dataset.text;
  if (prev === text) return;
  el.dataset.text = text;
  const before = [...(prev ?? "")];
  const animate = prev !== undefined && !reducedMotion();
  el.replaceChildren(
    ...[...text].map((c, i) => {
      const s = h("span", { class: "ch" }, c);
      if (animate && before[i] !== c)
        s.animate(
          [
            { transform: "translateY(0.55em)", opacity: 0, filter: "blur(3px)" },
            { transform: "none", opacity: 1, filter: "none" },
          ],
          { duration: 420, easing: EASE_OUT },
        );
      return s;
    }),
  );
}

const ODO_MS = 520;
const ODO_STAGGER = 35;

/**
 * Sets text like a mechanical counter: each changed character slides up and out while its
 * replacement rises in, the rightmost first. Characters in `separators` get the `odo-sep` class.
 */
export function odometer(el: HTMLElement, text: string, separators = ":"): void {
  const prev = el.dataset.text;
  if (prev === text) return;
  el.dataset.text = text;
  const chars = [...text];
  const cellClass = (c: string) => (separators.includes(c) ? "odo odo-sep" : "odo");
  if (el.children.length !== chars.length) {
    el.replaceChildren(...chars.map((c) => h("span", { class: cellClass(c) }, h("span", {}, c))));
    return;
  }
  const animate = prev !== undefined && !reducedMotion();
  const changed = chars.map((c, i) => el.children[i]?.lastElementChild?.textContent !== c);
  chars.forEach((c, i) => {
    const cell = el.children[i];
    if (!(cell instanceof HTMLElement) || !changed[i]) return;
    cell.className = cellClass(c);
    const leaving = cell.lastElementChild;
    const next = h("span", {}, c);
    if (!animate || !(leaving instanceof HTMLElement)) return void cell.replaceChildren(next);
    for (const old of cell.querySelectorAll(".odo-out")) old.remove();
    leaving.classList.add("odo-out");
    cell.append(next);
    // Like a counter: the rightmost changed digit moves first, the others follow.
    const delay = changed.slice(i + 1).filter(Boolean).length * ODO_STAGGER;
    leaving
      .animate([{ transform: "none", opacity: 1, filter: "none" }, { transform: "translateY(-75%)", opacity: 0, filter: "blur(2px)" }], {
        duration: ODO_MS * 0.7,
        delay,
        easing: EASE_OUT,
        fill: "forwards",
      })
      .finished.then(() => leaving.remove(), () => {});
    next.animate([{ transform: "translateY(75%)", opacity: 0, filter: "blur(2px)" }, { transform: "none", opacity: 1, filter: "none" }], {
      duration: ODO_MS,
      delay,
      easing: SPRING,
      fill: "backwards",
    });
  });
}

const tweens = new WeakMap<Element, { shown: number; to: number }>();

/** Counts the displayed number from its current value to `to`. */
export function tween(el: HTMLElement, to: number, format: (n: number) => string, ms = 600): void {
  const t = tweens.get(el);
  if (!t || reducedMotion()) {
    tweens.set(el, { shown: to, to });
    el.textContent = format(to);
    return;
  }
  if (t.to === to) return;
  const from = t.shown;
  t.to = to;
  const start = performance.now();
  const step = (now: number) => {
    if (t.to !== to) return;
    const k = Math.min(1, (now - start) / ms);
    t.shown = from + (to - from) * (1 - (1 - k) ** 3);
    el.textContent = format(t.shown);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
