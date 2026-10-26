/**
 * Toasts in the window's bottom-right corner: what went wrong (kept until closed, its first line
 * up front, the rest — a traceback, say — folded away, with a code and a way to copy it all) or a
 * short note that fades by itself.
 */
import { button, h, icon } from "../../../sdk/dom";
import type { Problem } from "../../../sdk/report";

const CLOSE = `<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>`;

/** More than this many at once, the oldest goes. */
export const MAX_TOASTS = 4;
/** How long a note stays. */
export const NOTE_MS = 4000;
/** How long Copy says it copied before it reads Copy again. */
export const COPIED_MS = 2000;

/** The line worth reading at a glance, and whatever follows it. */
export const splitMessage = (message: string): { summary: string; detail: string } => {
  const [first = "", ...rest] = message.trim().split("\n");
  return { summary: first.trim().replace(/:$/, ""), detail: rest.join("\n").replace(/^\n+|\s+$/g, "") };
};

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
      const { summary, detail } = splitMessage(p.message);

      const said = h("span", { "aria-live": "polite" }, "Copy");
      let back: ReturnType<typeof setTimeout> | undefined;
      const say = (text: string) => {
        said.textContent = text;
        clearTimeout(back);
        back = setTimeout(() => (said.textContent = "Copy"), COPIED_MS);
      };
      const copyBtn = button(said, () => {
        copy(problemText(p, at)).then(() => say("Copied"), () => say("Select the text to copy it"));
      }, { class: "toast-action toast-copy" });

      // The traceback, folded: opened, it shows its end, where the actual error is.
      const log = h("pre", { class: "toast-log", hidden: "" }, detail);
      const toggle = button("Details", () => {
        const open = log.hidden;
        log.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        toggle.textContent = open ? "Hide details" : "Details";
        if (open) log.scrollTop = log.scrollHeight;
      }, { class: "toast-action", "aria-expanded": "false" });

      const toast = h(
        "div",
        { class: "toast", "data-tone": "error", role: "alert" },
        h(
          "div",
          { class: "toast-head" },
          h("span", { class: "toast-dot", "aria-hidden": "true" }),
          h("div", { class: "toast-title" }, p.title),
          button(icon(CLOSE), () => close(toast, key), { class: "toast-close", "aria-label": "Close", title: "Close" }),
        ),
        h("div", { class: "toast-message" }, summary),
        ...(detail ? [log] : []),
        h(
          "div",
          { class: "toast-foot" },
          ...(detail ? [toggle] : []),
          h("code", { class: "toast-code", title: "Error code" }, p.code),
          copyBtn,
        ),
      );
      add(toast, key);
    },
    note(text) {
      const key = `note\n${text}`;
      const toast = h(
        "div",
        { class: "toast", "data-tone": "ok", role: "status" },
        h("div", { class: "toast-head" }, h("span", { class: "toast-dot", "aria-hidden": "true" }), h("div", { class: "toast-title" }, text)),
      );
      add(toast, key);
      setTimeout(() => close(toast, key), NOTE_MS);
    },
  };
}
