/**
 * Problems worth telling the user about (an action that failed, a system that refused), reported
 * from anywhere in a window: the window that shows them (Settings, as toasts) listens for them.
 * Elsewhere they only reach the console.
 */

/** A problem: what failed, why (as the system said it), and a short code to quote when asking for help. */
export type Problem = { readonly title: string; readonly message: string; readonly code: string };

export const PROBLEM_EVENT = "ain:problem";

/** The words of an error, whatever was thrown. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e) ?? String(e));

/** Calls `listener` with every problem reported in this window; returns how to stop. */
export function onProblem(listener: (p: Problem) => void): () => void {
  const on = (e: Event) => listener((e as CustomEvent<Problem>).detail);
  window.addEventListener(PROBLEM_EVENT, on);
  return () => window.removeEventListener(PROBLEM_EVENT, on);
}

/** Reports that `title` failed because of `error`, under `code` (e.g. "SETTINGS_SAVE"). */
export function reportProblem(title: string, error: unknown, code = "UNEXPECTED"): void {
  const problem: Problem = { title, message: messageOf(error), code };
  // A failure the page foresaw (the system refused) is a warning; one nothing caught is an error.
  (code === "UNEXPECTED" ? console.error : console.warn)(`[${code}] ${title}:`, error);
  // Code shared with Node (tests, tools) reports to the console alone.
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<Problem>(PROBLEM_EVENT, { detail: problem }));
}
