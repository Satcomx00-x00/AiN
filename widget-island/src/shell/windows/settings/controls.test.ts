// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { MAX_SEGMENTS, aroundPanel, optionControl, standardFields } = await import("./controls");
const { choice, toggle } = await import("../../../sdk/options");
const { dictation } = await import("../../../features/dictation");

describe("choice options in Settings", () => {
  it("show many choices as the island's drop-down list, the chosen one shown", () => {
    const many = choice("Theme", "c", [
      ["a", "Ash"],
      ["b", "Birch"],
      ["c", "Cedar"],
      ["d", "Dune"],
    ]);
    expect(many.choices.length).toBeGreaterThan(MAX_SEGMENTS);
    const onChange = vi.fn();
    const row = optionControl(many, "c", onChange);
    document.body.replaceChildren(row);
    const trigger = row.querySelector<HTMLButtonElement>(".ui-select-trigger")!;
    expect(trigger.textContent).toBe("Cedar");
    expect(row.querySelector("select")).toBeNull();
    trigger.click();
    row.querySelector<HTMLElement>("[role=option]")?.click();
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("keep a few short choices as buttons side by side", () => {
    const field = choice("Time format", "auto", [
      ["auto", "System"],
      ["24", "24-hour"],
      ["12", "12-hour"],
    ]);
    const row = optionControl(field, "24", vi.fn());
    expect(row.querySelector("select")).toBeNull();
    expect([...row.querySelectorAll("button")].map((b) => [b.textContent, b.getAttribute("aria-checked")])).toEqual([
      ["System", "false"],
      ["24-hour", "true"],
      ["12-hour", "false"],
    ]);
  });
});

describe("fields a plugin draws itself", () => {
  it("are left out of the standard controls", () => {
    const fields = { a: toggle("A", true), b: { ...toggle("B", true), inPanel: true } };
    expect(standardFields(fields).map(([key]) => key)).toEqual(["a"]);
  });

  it("leave out the speech model, which dictation's panel draws with its download state", () =>
    expect(standardFields(dictation.options ?? {}).map(([key]) => key)).toEqual(["mode", "modelDir", "trailingSpace"]));
});

describe("where a plugin's panel goes", () => {
  it("takes the place of the first field it draws", () => {
    const keys = (list: [string, unknown][]) => list.map(([key]) => key);
    const { before, after } = aroundPanel(dictation.options ?? {});
    expect([keys(before), keys(after)]).toEqual([["mode"], ["modelDir", "trailingSpace"]]);
  });

  it("goes last when the plugin draws none of its fields", () => {
    const { before, after } = aroundPanel({ a: toggle("A", true), b: toggle("B", false) });
    expect([before.length, after.length]).toEqual([2, 0]);
  });
});
