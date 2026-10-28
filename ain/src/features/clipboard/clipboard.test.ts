// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, ClipboardPort } from "./service";

const { clipboard } = await import(".");
const { matching, picker } = await import("./picker");

const NOW = 1_000_000;
const clip = (text: string, ago = 1000): Clip => ({ text, copiedAt: NOW - ago });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  document.body.replaceChildren();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A clipboard holding `clips`, recording what is copied. */
function port(clips: Clip[]): ClipboardPort & { copied: string[] } {
  const copied: string[] = [];
  let held = clips;
  return {
    copied,
    history: async () => held,
    copy: async (text) => void copied.push(text),
    copyImage: async () => {},
    clear: async () => void (held = []),
  };
}

describe("matching", () => {
  const clips = [clip("Ship the island"), clip("hello@example.com"), clip("#0A84FF")];
  it("keeps everything for an empty query", () => expect(matching(clips, "  ")).toEqual(clips));
  it("needs every word, in any order and case", () => expect(matching(clips, "ISLAND ship")).toEqual([clips[0]]));
  it("finds nothing when a word is missing", () => expect(matching(clips, "ship moon")).toEqual([]));
});

describe("the clipboard popup", () => {
  async function open(clips: Clip[], paste = true) {
    const clipboard = port(clips);
    const ctx = { services: { clipboard }, options: () => ({ paste }), close: vi.fn(), paste: vi.fn(async () => {}) };
    const root = document.createElement("div");
    document.body.append(root);
    const view = picker(root, ctx);
    view.show();
    await vi.advanceTimersByTimeAsync(0);
    const search = root.querySelector<HTMLInputElement>(".pk-search")!;
    const rows = () => [...root.querySelectorAll<HTMLElement>("[role=option]")];
    const key = (init: KeyboardEventInit) => search.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    return { root, ctx, clipboard, view, search, rows, key, selected: () => rows().findIndex((r) => r.getAttribute("aria-selected") === "true") };
  }

  it("lists the history, newest first, with how long ago and a quick key for the first nine", async () => {
    const p = await open([clip("one", 5_000), clip("two", 120_000)]);
    expect(p.rows().map((r) => r.querySelector(".pk-text")?.textContent)).toEqual(["one", "two"]);
    expect(p.rows()[0]?.querySelector(".pk-num")?.textContent).toBe("Alt 1");
    expect(p.rows()[1]?.querySelector(".pk-meta")?.textContent).toContain("2m");
    expect(p.root.querySelector(".pk-count")?.textContent).toBe("2 of 2");
    expect(p.selected()).toBe(0);
    expect(document.activeElement).toBe(p.search);
  });

  it("filters as you type, and says when nothing matches", async () => {
    const p = await open([clip("apple pie"), clip("banana")]);
    p.search.value = "ban";
    p.search.dispatchEvent(new Event("input"));
    expect(p.rows().map((r) => r.querySelector(".pk-text")?.textContent)).toEqual(["banana"]);
    p.search.value = "cherry";
    p.search.dispatchEvent(new Event("input"));
    expect(p.rows()).toHaveLength(0);
    expect(p.root.querySelector(".pk-empty")?.textContent).toBe("Nothing matches.");
  });

  it("moves the selection with the arrows, within the list", async () => {
    const p = await open([clip("a"), clip("b"), clip("c")]);
    p.key({ key: "ArrowDown" });
    p.key({ key: "ArrowDown" });
    p.key({ key: "ArrowDown" });
    expect(p.selected()).toBe(2);
    p.key({ key: "ArrowUp" });
    expect(p.selected()).toBe(1);
    expect(p.search.getAttribute("aria-activedescendant")).toBe("pk-1");
  });

  it("copies and pastes the selected clip on Enter", async () => {
    const p = await open([clip("a"), clip("b")]);
    p.key({ key: "ArrowDown" });
    p.key({ key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.clipboard.copied).toEqual(["b"]);
    expect(p.ctx.paste).toHaveBeenCalledTimes(1);
  });

  it("picks directly with Alt and a number, or a click", async () => {
    const p = await open([clip("a"), clip("b"), clip("c")]);
    p.key({ code: "Digit3", altKey: true });
    p.rows()[1]?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.clipboard.copied).toEqual(["c", "b"]);
  });

  it("only copies, and closes, when pasting is turned off", async () => {
    const p = await open([clip("a")], false);
    expect(p.root.querySelector(".pk-keys")?.textContent).toContain("Copy");
    p.key({ key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect([p.clipboard.copied, p.ctx.paste.mock.calls.length, p.ctx.close.mock.calls.length]).toEqual([["a"], 0, 1]);
  });

  it("closes when pasting fails", async () => {
    const p = await open([clip("a")]);
    p.ctx.paste.mockRejectedValueOnce(new Error("no window"));
    p.key({ key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.ctx.close).toHaveBeenCalled();
  });

  it("says what to do when nothing was copied yet, or the history can't be read", async () => {
    const p = await open([]);
    expect(p.root.querySelector(".pk-empty")?.textContent).toContain("Nothing copied yet");
    p.clipboard.history = async () => Promise.reject(new Error("locked"));
    p.view.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.rows()).toHaveLength(0);
  });

  it("starts each showing with an empty search", async () => {
    const p = await open([clip("a"), clip("b")]);
    p.search.value = "a";
    p.view.show();
    await vi.advanceTimersByTimeAsync(0);
    expect([p.search.value, p.rows().length]).toEqual(["", 2]);
  });

  it("gives a quick key to the first nine clips only", async () => {
    const p = await open(Array.from({ length: 10 }, (_, i) => clip(`clip ${i}`)));
    expect(p.rows().map((r) => r.querySelector(".pk-num")?.textContent ?? null)).toEqual([...Array.from({ length: 9 }, (_, i) => `Alt ${i + 1}`), null]);
  });

  it("follows the mouse with the selection", async () => {
    const p = await open([clip("a"), clip("b"), clip("c")]);
    p.rows()[2]?.dispatchEvent(new MouseEvent("mousemove"));
    expect(p.selected()).toBe(2);
    p.rows()[2]?.dispatchEvent(new MouseEvent("mousemove"));
    expect([p.selected(), p.search.getAttribute("aria-activedescendant")]).toEqual([2, "pk-2"]);
  });

  it("leaves other keys to the search field", async () => {
    const p = await open([clip("a")]);
    expect(p.key({ key: "a" })).toBe(true);
    expect(p.key({ key: "ArrowDown" })).toBe(false);
    expect(p.clipboard.copied).toEqual([]);
  });

  it("ignores a pick with nothing there", async () => {
    const p = await open([clip("a")]);
    p.key({ code: "Digit5", altKey: true });
    p.search.value = "zzz";
    p.search.dispatchEvent(new Event("input"));
    p.key({ key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect([p.clipboard.copied, p.ctx.paste.mock.calls.length, p.ctx.close.mock.calls.length]).toEqual([[], 0, 0]);
  });

  it("still pastes when copying failed, leaving what was on the clipboard", async () => {
    const p = await open([clip("a")]);
    p.clipboard.copy = async () => Promise.reject(new Error("busy"));
    p.key({ key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.ctx.paste).toHaveBeenCalledTimes(1);
  });
});

describe("the clipboard tab", () => {
  async function tab(clips: Clip[], copyFails = false) {
    const p = port(clips);
    if (copyFails) p.copy = async () => Promise.reject(new Error("busy"));
    const widget = clipboard.setup({ clipboard: p }, { refresh() {}, options: () => ({ paste: true }), setOptions() {}, secret: async () => "", openSettings() {}, openPage() {}, appearance: () => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }) as const, notify: () => ({ id: "", update() {}, dismiss() {} }), on: () => () => {} });
    const root = document.createElement("section");
    widget.panel?.(root);
    await widget.tick?.({ now: NOW, visible: true });
    return { root, port: p, widget, rows: () => [...root.querySelectorAll<HTMLButtonElement>(".clip")] };
  }

  it("lists recent clips with how long ago they were copied", async () => {
    const t = await tab([clip("hello", 42_000), clip("#0A84FF", 5 * 60_000)]);
    expect(t.rows().map((r) => r.querySelector(".clip-text")?.textContent)).toEqual(["hello", "#0A84FF"]);
    expect(t.rows().map((r) => r.querySelector(".clip-meta")?.textContent)).toEqual(["42s", "5m"]);
    expect(t.root.querySelector(".eyebrow")?.textContent).toBe("2 recent");
  });

  it("copies a clip when clicked, says so, then shows its age again", async () => {
    const t = await tab([clip("hello")]);
    t.rows()[0]?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.port.copied).toEqual(["hello"]);
    expect([t.rows()[0]?.dataset.copied, t.rows()[0]?.querySelector(".clip-meta")?.textContent]).toEqual(["true", "Copied"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.rows()[0]?.dataset.copied).toBeUndefined();
  });

  it("says when copying failed", async () => {
    const t = await tab([clip("hello")], true);
    t.rows()[0]?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect([t.rows()[0]?.dataset.copied, t.rows()[0]?.querySelector(".clip-meta")?.textContent]).toEqual(["false", "Failed"]);
  });

  it("clears the history, then invites copying", async () => {
    const t = await tab([clip("hello")]);
    const clear = [...t.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Clear")!;
    clear.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.rows()).toHaveLength(0);
    expect(t.root.querySelector<HTMLElement>(".empty")?.hidden).toBe(false);
    expect(clear.hidden).toBe(true);
  });

  it("keeps a row when the history changes around it", async () => {
    const t = await tab([clip("b"), clip("a")]);
    const kept = t.rows()[1];
    t.port.history = async () => [clip("c"), clip("b"), clip("a")];
    await t.widget.tick?.({ now: NOW, visible: true });
    expect(t.rows().map((r) => r.querySelector(".clip-text")?.textContent)).toEqual(["c", "b", "a"]);
    expect(t.rows()[2]).toBe(kept);
  });
  it("keeps saying a clip was copied while the history refreshes", async () => {
    const t = await tab([clip("hello")]);
    t.rows()[0]?.click();
    await vi.advanceTimersByTimeAsync(0);
    await t.widget.tick?.({ now: NOW, visible: true });
    expect(t.rows()[0]?.querySelector(".clip-meta")?.textContent).toBe("Copied");
  });

  it("doesn't read the history while the tab is hidden", async () => {
    const t = await tab([clip("hello")]);
    const history = vi.spyOn(t.port, "history");
    expect(t.widget.tick?.({ now: NOW, visible: false })).toBeUndefined();
    expect(history).not.toHaveBeenCalled();
  });

  it("slides new clips in and moved ones to their new place", async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
    // Rows are 30px tall, stacked in list order.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return { top: [...(this.parentElement?.children ?? [])].indexOf(this) * 30 } as DOMRect;
    });
    const animate = vi.spyOn(Element.prototype, "animate").mockReturnValue({} as Animation);
    const t = await tab([clip("b"), clip("a")]);
    expect(animate.mock.calls.map(([, o]) => (o as KeyframeAnimationOptions).delay)).toEqual([0, 35]);

    animate.mockClear();
    t.port.history = async () => [clip("c"), clip("b"), clip("a")];
    await t.widget.tick?.({ now: NOW, visible: true });
    const moves = animate.mock.calls.map(([frames]) => (frames as Keyframe[])[0]?.transform);
    expect(moves).toEqual(["translateY(-6px) scale(0.98)", "translateY(-30px)", "translateY(-30px)"]);

    animate.mockClear();
    t.port.history = async () => [clip("c"), clip("b")];
    await t.widget.tick?.({ now: NOW, visible: true });
    expect(animate).not.toHaveBeenCalled();
  });
});
