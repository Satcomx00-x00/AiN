// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { MAX_SEGMENTS, aroundPanel, optionControl, standardFields } = await import("./controls");
const { choice, color, number, secret, text, toggle } = await import("../../../sdk/options");
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

describe("option controls for what the user types", () => {
  const errorOf = (row: HTMLElement) => row.querySelector(".field-error")?.textContent ?? null;
  const change = (el: Element | null, value: string, event = "change") => {
    (el as HTMLInputElement).value = value;
    el!.dispatchEvent(new Event(event));
  };

  it("types a number in a box when asked, saving only one in range", () => {
    const onChange = vi.fn();
    const row = optionControl(number("Port", 8080, { min: 1, max: 65535, box: true, unit: "tcp" }), 8080, onChange);
    expect(row.querySelector("input[type=range]")).toBeNull();
    expect(row.querySelector(".number-unit")?.textContent).toBe("tcp");
    change(row.querySelector("input"), "0");
    expect(errorOf(row)).toBe("Between 1 and 65535 tcp.");
    change(row.querySelector("input"), "");
    expect(errorOf(row)).toBe("Type a number.");
    expect(onChange).not.toHaveBeenCalled();
    change(row.querySelector("input"), "443");
    expect(errorOf(row)).toBeNull();
    expect(onChange).toHaveBeenCalledWith(443);
  });

  it("keeps a slider for a number by default", () => {
    expect(optionControl(number("Size", 4, { min: 0, max: 10 }), 4, vi.fn()).querySelector("input[type=range]")).not.toBeNull();
  });

  it("draws several lines for a multiline text, and saves an emptied required one while saying it's required", () => {
    const onChange = vi.fn();
    const row = optionControl(text("Template", "hi", { multiline: true, required: true, maxLength: 50 }), "hi", onChange);
    const area = row.querySelector("textarea")!;
    expect(area.value).toBe("hi");
    expect(area.getAttribute("maxlength")).toBe("50");
    expect(errorOf(row)).toBeNull();
    change(area, "  ");
    expect(errorOf(row)).toBe("Required.");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("draws a color picker that goes back to the field's default", () => {
    const onChange = vi.fn();
    const row = optionControl(color("Tint", "#ff8800"), "#00aaff", onChange);
    const reset = [...row.querySelectorAll("button")].find((b) => b.textContent === "Default")!;
    expect(reset.hidden).toBe(false);
    reset.click();
    expect(onChange).toHaveBeenLastCalledWith("#ff8800");
  });

  it("never shows a saved secret, only that there is one", async () => {
    let kept = "abcd1234";
    const save = vi.fn(async (v: string) => void (kept = v));
    const row = optionControl(secret("Token", { pattern: "[a-z0-9]{8}", invalid: "8 letters or digits" }), "", vi.fn(), undefined, { saved: async () => kept !== "", save });
    const input = row.querySelector<HTMLInputElement>("input[type=password]")!;
    await Promise.resolve();
    await Promise.resolve();
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Saved: type a new one to replace it");
    expect(row.querySelector(".secret-state")?.textContent).toContain("credential store");

    const press = (label: string) => [...row.querySelectorAll("button")].find((b) => b.textContent === label)!.click();
    change(input, "nope", "input");
    press("Save");
    await Promise.resolve();
    expect(errorOf(row)).toBe("Expected 8 letters or digits.");
    expect(save).not.toHaveBeenCalled();

    press("Remove");
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(""));
    await vi.waitFor(() => expect(input.placeholder).toBe("Not set"));
  });

  it("says a secret can't be set where there's no credential store", () => {
    const row = optionControl(secret("Token"), "", vi.fn());
    const input = row.querySelector<HTMLInputElement>("input[type=password]")!;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("Secrets can only be set in the app");
  });
});
