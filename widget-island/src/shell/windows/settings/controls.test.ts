// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { MAX_SEGMENTS, optionControl } = await import("./controls");
const { choice } = await import("../../../sdk/options");
const { dictation } = await import("../../../features/dictation");

describe("choice options in Settings", () => {
  it("show the speech models as a drop-down list, the chosen one selected", () => {
    const model = dictation.options?.model;
    if (!model) throw new Error("dictation has no model option");
    expect(model.choices.length).toBeGreaterThan(MAX_SEGMENTS);
    const chosen = model.choices[2]!.value;
    const onChange = vi.fn();
    const row = optionControl(model, chosen, onChange);
    const select = row.querySelector("select");
    expect(select?.value).toBe(chosen);
    expect(select?.options.length).toBe(model.choices.length);
    expect(row.querySelectorAll("button")).toHaveLength(0);

    select!.value = model.choices[0]!.value;
    select!.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledWith(model.choices[0]!.value);
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
