// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { select } = await import("./select");

const options = [
  { value: "a", label: "Alpha", detail: "The first", meta: "10 MB" },
  { value: "b", label: "Beta", detail: "The second", meta: "20 MB", badge: "Downloaded" },
  { value: "c", label: "Gamma" },
];

beforeEach(() => document.body.replaceChildren());

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

  it("follows new options and values without reporting them as choices", () => {
    const { s, trigger, onChange } = mount("a");
    s.setOptions(options.map((o) => ({ ...o, badge: "Downloaded" })));
    s.set("c");
    expect(trigger.textContent).toContain("Gamma");
    expect(trigger.textContent).toContain("Downloaded");
    expect(onChange).not.toHaveBeenCalled();
  });
});
