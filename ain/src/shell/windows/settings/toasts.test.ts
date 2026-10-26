// @vitest-environment happy-dom
/** Toasts: what went wrong stays until closed, can be copied whole, and never piles up past a few. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { COPIED_MS, MAX_TOASTS, NOTE_MS, problemText, splitMessage, toaster } from "./toasts";

const problem = (n = 1) => ({ title: `Couldn't save ${n}`, message: "disk full (os error 112)", code: "SETTINGS_SAVE" });
const press = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === label)!.click();
const tick = () => new Promise((r) => setTimeout(r));

afterEach(() => vi.useRealTimers());

describe("a problem's toast", () => {
  it("shows what failed, the system's words and the code, until it's closed", async () => {
    vi.useFakeTimers();
    const t = toaster(async () => {});
    t.problem(problem());
    const toast = t.el.querySelector<HTMLElement>(".toast")!;
    expect(toast.getAttribute("role")).toBe("alert");
    expect([".toast-title", ".toast-message", ".toast-code"].map((c) => toast.querySelector(c)?.textContent)).toEqual(["Couldn't save 1", "disk full (os error 112)", "SETTINGS_SAVE"]);
    vi.advanceTimersByTime(60_000);
    expect(t.el.contains(toast)).toBe(true);
    press(toast, "Close");
    vi.advanceTimersByTime(300);
    expect(t.el.childElementCount).toBe(0);
  });

  it("copies the code, the title, the words and when it happened", async () => {
    const copy = vi.fn(async (_: string) => {});
    const t = toaster(copy);
    t.problem(problem());
    press(t.el, "Copy");
    await tick();
    expect(copy.mock.calls[0]![0]).toMatch(/^\[SETTINGS_SAVE\] Couldn't save 1\ndisk full \(os error 112\)\n\d{4}-\d\d-\d\dT/);
    expect(t.el.querySelector(".toast-copy")?.textContent).toBe("Copied");
  });

  it("reads Copy again a moment after copying", async () => {
    vi.useFakeTimers();
    const t = toaster(async () => {});
    t.problem(problem());
    press(t.el, "Copy");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.el.querySelector(".toast-copy")?.textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(COPIED_MS);
    expect(t.el.querySelector(".toast-copy")?.textContent).toBe("Copy");
  });

  it("says to select the text when the clipboard refuses", async () => {
    const t = toaster(async () => Promise.reject(new Error("denied")));
    t.problem(problem());
    press(t.el, "Copy");
    await tick();
    expect(t.el.querySelector(".toast-copy")?.textContent).toBe("Select the text to copy it");
  });

  it("puts a traceback's first line up front and folds the rest away", () => {
    const t = toaster(async () => {});
    t.problem({ title: "PersonaPlex didn't start", message: "PersonaPlex stopped (exit code: 1):\n  File \"x.py\", line 1\nRuntimeError: boom\n", code: "PERSONA_TEST" });
    const log = t.el.querySelector<HTMLElement>(".toast-log")!;
    expect(t.el.querySelector(".toast-message")?.textContent).toBe("PersonaPlex stopped (exit code: 1)");
    expect([log.textContent, log.hidden]).toEqual(['  File "x.py", line 1\nRuntimeError: boom', true]);
    press(t.el, "Details");
    expect(log.hidden).toBe(false);
    press(t.el, "Hide details");
    expect(log.hidden).toBe(true);
  });

  it("has nothing to fold when the words fit on a line", () => {
    const t = toaster(async () => {});
    t.problem(problem());
    expect([t.el.querySelector(".toast-log"), [...t.el.querySelectorAll("button")].some((b) => b.textContent === "Details")]).toEqual([null, false]);
    expect(splitMessage("disk full")).toEqual({ summary: "disk full", detail: "" });
  });

  it("shows the same problem once, and keeps only the latest few", () => {
    const t = toaster(async () => {});
    t.problem(problem());
    t.problem(problem());
    expect(t.el.childElementCount).toBe(1);
    for (let n = 2; n <= MAX_TOASTS + 2; n++) t.problem(problem(n));
    expect(t.el.childElementCount).toBe(MAX_TOASTS);
    expect(t.el.querySelector(".toast-title")?.textContent).toBe(`Couldn't save 3`);
  });

  it("formats what's copied the same way every time", () => {
    expect(problemText(problem(), new Date("2026-10-26T18:00:00Z"))).toBe("[SETTINGS_SAVE] Couldn't save 1\ndisk full (os error 112)\n2026-10-26T18:00:00.000Z");
  });
});

describe("a note's toast", () => {
  it("goes by itself", () => {
    vi.useFakeTimers();
    const t = toaster(async () => {});
    t.note("Back to the defaults");
    expect(t.el.querySelector(".toast")?.getAttribute("role")).toBe("status");
    vi.advanceTimersByTime(NOTE_MS + 300);
    expect(t.el.childElementCount).toBe(0);
  });
});
