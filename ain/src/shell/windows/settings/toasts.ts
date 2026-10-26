/**
 * Toasts in the window's bottom-right corner: what went wrong (kept until closed, its words
 * selectable, with a code and a button to copy it all) or a short note that fades by itself.
 */
import { button, h, icon } from "../../../sdk/dom";
import type { Problem } from "../../../sdk/report";

const ERROR = `<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 10.9v.01"/>`;
const DONE = `<circle cx="8" cy="8" r="6"/><path d="M5.6 8.1l1.7 1.7 3.2-3.5"/>`;
const CLOSE = `<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>`;
const COPY = `<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.75c0-.7-.55-1.25-1.25-1.25h-5.5c-.7 0-1.25.55-1.25 1.25v5.5c0 .7.55 1.25 1.25 1.25H5.5"/>`;

/** More than this many at once, the oldest goes. */
export const MAX_TOASTS = 4;
/** How long a note stays. */
export const NOTE_MS = 4000;

/** What Copy puts on the clipboard: enough to paste into a bug report. */
export const problemText = (p: Problem, at: Date): string => `[${p.code}] ${p.title}\n${p.message}\n${at.toISOString()}`;

export interface Toaster {
  readonly el: HTMLElement;
  /** Shows a problem until it's closed; the same one again (same code and words) only once. */
  problem(p: Problem): void;
  /** Shows a short note that goes by itself. */
  note(text: string): void;
}

export function toaster(copy: (text: string) => Promise<void> = (text) => navigator.clipboard.writeText(text)): Toaster {
  const el = h("div", { class: "toasts", role: "region", "aria-label": "Notifications" });
  const shown = new Map<string, HTMLElement>();

  const add = (toast: HTMLElement, key: string) => {
    shown.get(key)?.remove();
    shown.set(key, toast);
    el.append(toast);
    while (el.childElementCount > MAX_TOASTS) {
      const oldest = el.firstElementChild!;
      for (const [k, t] of shown) if (t === oldest) shown.delete(k);
      oldest.remove();
    }
  };
  const close = (toast: HTMLElement, key: string) => {
    if (shown.get(key) === toast) shown.delete(key);
    toast.classList.add("leaving");
    // Gone once it has faded, or at once where nothing animates.
    const gone = () => toast.remove();
    toast.addEventListener("animationend", gone, { once: true });
    setTimeout(gone, 250);
  };

  return {
    el,
    problem(p) {
      const at = new Date();
      const key = `${p.code}\n${p.title}\n${p.message}`;
      const copied = h("span", { class: "toast-copied", "aria-live": "polite" });
      const toast = h(
        "div",
        { class: "toast", "data-tone": "error", role: "alert" },
        h("span", { class: "toast-ico", "aria-hidden": "true" }, icon(ERROR)),
        h(
          "div",
          { class: "toast-body" },
          h("div", { class: "toast-title" }, p.title),
          h("div", { class: "toast-message" }, p.message),
          h(
            "div",
            { class: "toast-foot" },
            h("code", { class: "toast-code", title: "Error code" }, p.code),
            button(h("span", { class: "toast-btn-in" }, icon(COPY), "Copy"), () => {
              copy(problemText(p, at)).then(
                () => (copied.textContent = "Copied"),
                () => (copied.textContent = "Select the text to copy it"),
              );
            }, { class: "toast-btn" }),
            copied,
          ),
        ),
        button(icon(CLOSE), () => close(toast, key), { class: "toast-close", "aria-label": "Close", title: "Close" }),
      );
      add(toast, key);
    },
    note(text) {
      const key = `note\n${text}`;
      const toast = h(
        "div",
        { class: "toast", "data-tone": "ok", role: "status" },
        h("span", { class: "toast-ico", "aria-hidden": "true" }, icon(DONE)),
        h("div", { class: "toast-body" }, h("div", { class: "toast-title" }, text)),
      );
      add(toast, key);
      setTimeout(() => close(toast, key), NOTE_MS);
    },
  };
}
