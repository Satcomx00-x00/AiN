// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { select } = await import("./select");

const options = [
  { value: "a", label: "Alpha", detail: "The first", meta: "10 MB" },
  { value: "b", label: "Beta", detail: "The second", meta: "20 MB", badge: "Downloaded" },
  { value: "c", label: "Gamma" },
];

beforeEach(() => document.body.replaceChildren());
afterEach(() => vi.restoreAllMocks());

function mount(value = "a") {
  const onChange = vi.fn();
  const s = select(options, value, onChange, "Model");
  document.body.append(s.el);
  const trigger = s.el.querySelector<HTMLButtonElement>(".ui-select-trigger")!;
  const list = s.el.querySelector<HTMLElement>("[role=listbox]")!;
  const rows = () => [...list.querySelectorAll<HTMLElement>("[role=option]")];
  const key = (target: HTMLElement, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  return { s, onChange, trigger, list, rows, key };
}

describe("select", () => {
  it("shows the chosen option, closed, as a labelled combobox button", () => {
    const { trigger, list } = mount("b");
    expect(trigger.textContent).toContain("Beta");
    expect(trigger.textContent).toContain("The second");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBe("Model");
    expect(list.hidden).toBe(true);
  });

  it("lists every option with its details, the chosen one marked", () => {
    const { trigger, rows } = mount("b");
    trigger.click();
    expect(rows().map((r) => [r.querySelector(".ui-select-label")?.textContent, r.getAttribute("aria-selected")])).toEqual([
      ["Alpha", "false"],
      ["BetaDownloaded", "true"],
      ["Gamma", "false"],
    ]);
    expect(rows()[0]?.querySelector(".ui-select-meta")?.textContent).toBe("10 MB");
  });

  it("chooses with a click, closes, and reports the new value once", () => {
    const { s, trigger, rows, onChange, list } = mount();
    trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    rows()[2]?.click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("c");
    expect(list.hidden).toBe(true);
    expect(s.el.querySelector(".ui-select-trigger")?.textContent).toContain("Gamma");
  });

  it("doesn't report choosing what was already chosen", () => {
    const { trigger, rows, onChange } = mount("a");
    trigger.click();
    rows()[0]?.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("works from the keyboard: open, move, choose, and back to the button", () => {
    const { trigger, list, key, onChange } = mount("a");
    key(trigger, "ArrowDown");
    expect(list.hidden).toBe(false);
    expect(document.activeElement).toBe(list);
    key(list, "ArrowDown");
    key(list, "ArrowDown");
    key(list, "ArrowDown"); // already at the end: stays on the last one
    expect(list.getAttribute("aria-activedescendant")).toMatch(/-2$/);
    key(list, "Home");
    key(list, "ArrowDown");
    key(list, "Enter");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("b");
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes without choosing on Escape or a click elsewhere", () => {
    const { trigger, list, key, onChange } = mount();
    trigger.click();
    key(list, "Escape");
    expect(list.hidden).toBe(true);
    trigger.click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(list.hidden).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves the highlight with the pointer, and up, to the end and back with the keys", () => {
    const { trigger, list, rows, key } = mount("a");
    trigger.click();
    const active = () => rows().findIndex((r) => r.classList.contains("active"));
    rows()[1]!.dispatchEvent(new Event("pointermove"));
    rows()[1]!.dispatchEvent(new Event("pointermove"));
    expect(active()).toBe(1);
    key(list, "End");
    expect(active()).toBe(2);
    key(list, "ArrowUp");
    expect(active()).toBe(1);
    expect(list.getAttribute("aria-activedescendant")).toMatch(/-1$/);
  });

  it("chooses with Space, and closes on Tab without keeping the key from moving focus", () => {
    const { trigger, list, onChange } = mount("a");
    trigger.click();
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    list.dispatchEvent(space);
    expect([onChange.mock.calls, space.defaultPrevented, list.hidden]).toEqual([[["b"]], true, true]);
    trigger.click();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    list.dispatchEvent(tab);
    expect([tab.defaultPrevented, list.hidden]).toEqual([false, true]);
  });

  it("leaves other keys alone, open or closed", () => {
    const { trigger, list, onChange } = mount("a");
    const onButton = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    trigger.dispatchEvent(onButton);
    expect([onButton.defaultPrevented, list.hidden]).toEqual([false, true]);
    trigger.click();
    const inList = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    list.dispatchEvent(inList);
    expect([inList.defaultPrevented, list.hidden]).toEqual([false, false]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles from its button, and stays open on more open keys or a click inside", () => {
    const { s, trigger, list, key } = mount("a");
    trigger.click();
    key(trigger, "ArrowDown");
    s.el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(list.hidden).toBe(false);
    trigger.click();
    expect([list.hidden, trigger.getAttribute("aria-expanded")]).toEqual([true, "false"]);
  });

  it("does nothing on keys meant for the open list while it is closed", () => {
    const { list, key, onChange } = mount("a");
    key(list, "Enter");
    key(list, "Escape");
    expect([list.hidden, onChange.mock.calls.length]).toEqual([true, 0]);
  });

  it("doesn't open without options, and keeps the open list's highlight as they change", () => {
    const empty = select([], "", vi.fn(), "Model");
    document.body.append(empty.el);
    empty.el.querySelector<HTMLButtonElement>(".ui-select-trigger")!.click();
    expect(empty.el.querySelector<HTMLElement>("[role=listbox]")!.hidden).toBe(true);

    const { s, trigger, list, rows } = mount("b");
    trigger.click();
    s.setOptions(options.map((o) => ({ ...o, meta: "new" })));
    expect(rows().findIndex((r) => r.classList.contains("active"))).toBe(1);
    expect(list.getAttribute("aria-activedescendant")).toMatch(/-1$/);
    // Every option gone while open: nothing to highlight, and the list stays as it is.
    s.setOptions([]);
    expect([rows().length, list.hidden, trigger.textContent]).toEqual([0, false, ""]);
  });

  it("opens upward when there's more room above than below", () => {
    const { s, trigger } = mount("a");
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const rect = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: 700, bottom: 720 } as DOMRect);
    trigger.click();
    expect(s.el.classList.contains("up")).toBe(true);
    trigger.click();
    rect.mockReturnValue({ top: 100, bottom: 600 } as DOMRect);
    trigger.click();
    expect(s.el.classList.contains("up")).toBe(false);
  });

  it("follows new options and values without reporting them as choices", () => {
    const { s, trigger, onChange } = mount("a");
    s.setOptions(options.map((o) => ({ ...o, badge: "Downloaded" })));
    s.set("c");
    expect(trigger.textContent).toContain("Gamma");
    expect(trigger.textContent).toContain("Downloaded");
    expect(onChange).not.toHaveBeenCalled();
  });
});
