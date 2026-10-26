// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Problem, onProblem } from "../../../sdk/report";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { MAX_SEGMENTS, aroundPanel, colorPicker, optionControl, rangeControl, standardFields, themeGrid } = await import("./controls");
const { choice, color, folder, list, number, secret, text, toggle } = await import("../../../sdk/options");
const { THEMES } = await import("../../themes");
const { dictation } = await import("../../../features/dictation");

/** Collects the problems reported until `stop`. */
const problems = () => {
  const list: Problem[] = [];
  return { list, stop: onProblem((p) => list.push(p)) };
};

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
    expect(standardFields(dictation.options ?? {}).map(([key]) => key)).toEqual(["mode", "modelDir", "keepLoaded", "trailingSpace"]));
});

describe("where a plugin's panel goes", () => {
  it("takes the place of the first field it draws", () => {
    const keys = (list: [string, unknown][]) => list.map(([key]) => key);
    const { before, after } = aroundPanel(dictation.options ?? {});
    expect([keys(before), keys(after)]).toEqual([["mode"], ["modelDir", "keepLoaded", "trailingSpace"]]);
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

const buttonOf = (root: ParentNode, label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === label)!;
const errorOf = (row: HTMLElement) => row.querySelector(".field-error")?.textContent ?? null;
/** Lets pending promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a slider", () => {
  it("shows the value with its unit as it moves, and saves it", () => {
    const onChange = vi.fn();
    const wrap = rangeControl(200, { min: 100, max: 300, step: 10, unit: "ms" }, onChange, "Delay");
    const input = wrap.querySelector<HTMLInputElement>("input[type=range]")!;
    expect(wrap.querySelector("output")?.textContent).toBe("200 ms");
    expect(input.style.getPropertyValue("--p")).toBe("0.5");
    input.value = "250";
    input.dispatchEvent(new Event("input"));
    expect(wrap.querySelector("output")?.textContent).toBe("250 ms");
    expect(input.style.getPropertyValue("--p")).toBe("0.75");
    expect(onChange).toHaveBeenCalledWith(250);
  });

  it("still draws when its range is a single value", () => {
    const input = rangeControl(5, { min: 5, max: 5, step: 1 }, vi.fn(), "Fixed").querySelector<HTMLInputElement>("input")!;
    expect(input.style.getPropertyValue("--p")).toBe("0");
  });
});

describe("the color picker", () => {
  const picker = (value = "#ff0000", fallback = "#000000") => {
    const onChange = vi.fn();
    const el = colorPicker(value, fallback, onChange, "Pill color");
    document.body.replaceChildren(el);
    const area = el.querySelector<HTMLElement>(".cp-area")!;
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
    return {
      el,
      onChange,
      area,
      swatch: el.querySelector<HTMLButtonElement>(".cp-swatch")!,
      panel: el.querySelector<HTMLElement>(".cp-panel")!,
      hex: el.querySelector<HTMLInputElement>(".cp-hex")!,
      hue: el.querySelector<HTMLInputElement>(".cp-hue")!,
    };
  };
  const pointer = (type: string, x: number, y: number, pointerId = 1) => new PointerEvent(type, { clientX: x, clientY: y, pointerId });

  it("opens and closes its palette from the swatch", () => {
    const { swatch, panel, hex } = picker();
    expect(hex.value).toBe("#ff0000");
    expect(panel.hidden).toBe(true);
    swatch.click();
    expect([panel.hidden, swatch.getAttribute("aria-expanded")]).toEqual([false, "true"]);
    swatch.click();
    expect([panel.hidden, swatch.getAttribute("aria-expanded")]).toEqual([true, "false"]);
  });

  it("picks saturation and brightness where the square is pressed, and follows the drag", () => {
    const { area, onChange, hex } = picker();
    area.dispatchEvent(pointer("pointerdown", 50, 25));
    expect(onChange).toHaveBeenLastCalledWith("#bf6060");
    expect(hex.value).toBe("#bf6060");
    expect(document.activeElement).toBe(area);
    area.dispatchEvent(pointer("pointermove", 100, 0));
    expect(onChange).toHaveBeenLastCalledWith("#ff0000");
    // Another pointer, never pressed on the square, moves nothing.
    area.dispatchEvent(pointer("pointermove", 0, 100, 2));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("still picks for a pointer it can't capture", () => {
    const { area, onChange } = picker();
    area.setPointerCapture = () => {
      throw new DOMException("not an active pointer", "NotFoundError");
    };
    area.dispatchEvent(pointer("pointerdown", 0, 0));
    expect(onChange).toHaveBeenLastCalledWith("#ffffff");
  });

  it("moves with the arrow keys, further with Shift, and ignores other keys", () => {
    const { area, onChange } = picker("#808080");
    const press = (key: string, shiftKey = false) => {
      const e = new KeyboardEvent("keydown", { key, shiftKey, cancelable: true });
      area.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press("ArrowUp", true)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("#9a9a9a");
    press("ArrowDown", true);
    expect(onChange).toHaveBeenLastCalledWith("#808080");
    press("ArrowRight");
    press("ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("#808080");
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(press("a")).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("changes the hue from its slider", () => {
    const { hue, onChange } = picker();
    hue.value = "120";
    hue.dispatchEvent(new Event("input"));
    expect(onChange).toHaveBeenLastCalledWith("#00ff00");
  });

  it("takes a typed hex code once it's whole, without rewriting it while typing, and tidies it after", () => {
    const { hex, onChange } = picker();
    hex.focus();
    hex.value = "0A8";
    hex.dispatchEvent(new Event("input"));
    expect(onChange).toHaveBeenLastCalledWith("#00aa88");
    expect(hex.value).toBe("0A8");
    hex.value = "nope";
    hex.dispatchEvent(new Event("input"));
    expect(onChange).toHaveBeenCalledTimes(1);
    hex.dispatchEvent(new Event("change"));
    expect(hex.value).toBe("#00aa88");
  });

  it("goes back to the theme color, then hides that button", () => {
    const { el, onChange } = picker("#123456", "#0a84ff");
    const reset = buttonOf(el, "Theme color");
    expect(reset.hidden).toBe(false);
    reset.click();
    expect(onChange).toHaveBeenLastCalledWith("#0a84ff");
    expect(reset.hidden).toBe(true);
  });
});

describe("the theme tiles", () => {
  it("mark the current theme and pick the one clicked", () => {
    const [first, second] = THEMES;
    const onPick = vi.fn();
    const grid = themeGrid(THEMES, first!.id, onPick);
    const tiles = [...grid.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    expect(tiles.map((t) => t.getAttribute("aria-checked")).slice(0, 2)).toEqual(["true", "false"]);
    expect(tiles[1]?.querySelector(".theme-name")?.textContent).toBe(second!.name);
    tiles[1]?.click();
    expect(onPick).toHaveBeenCalledWith(second);
  });
});

describe("a list option", () => {
  const chipsOf = (row: HTMLElement) => [...row.querySelectorAll(".chip")].map((c) => c.textContent);
  const enter = (input: HTMLInputElement, value: string, key = "Enter") => {
    input.value = value;
    input.dispatchEvent(new KeyboardEvent("keydown", { key }));
  };

  it("adds what's typed on Enter, once, and removes a chip from its button", () => {
    const onChange = vi.fn();
    const row = optionControl(list("Apps", ["Slack"]), ["Slack"], onChange);
    document.body.replaceChildren(row);
    const input = row.querySelector<HTMLInputElement>(".chip-input")!;
    expect(input.placeholder).toBe("Add…");

    enter(input, " Zoom ", "a");
    expect(chipsOf(row)).toEqual(["Slack"]);
    enter(input, "   ");
    enter(input, "Slack");
    expect(onChange).not.toHaveBeenCalled();
    enter(input, " Zoom ");
    expect(chipsOf(row)).toEqual(["Slack", "Zoom"]);
    expect(onChange).toHaveBeenLastCalledWith(["Slack", "Zoom"]);
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);

    row.querySelector<HTMLButtonElement>("[aria-label='Remove Slack']")!.click();
    expect(chipsOf(row)).toEqual(["Zoom"]);
    expect(onChange).toHaveBeenLastCalledWith(["Zoom"]);
  });
});

describe("a folder option", () => {
  const pathOf = (row: HTMLElement) => row.querySelector<HTMLInputElement>(".path-input")!;

  it("takes the folder picked in the system dialog, and Default clears it", async () => {
    const onChange = vi.fn();
    const pick = vi.fn(async () => "/models");
    const row = optionControl(folder("Models"), "", onChange, pick);
    expect(pathOf(row).placeholder).toBe("Default location");
    expect(buttonOf(row, "Default").hidden).toBe(true);
    buttonOf(row, "Browse…").click();
    await settle();
    expect(pick).toHaveBeenCalledWith("");
    expect(pathOf(row).value).toBe("/models");
    expect(onChange).toHaveBeenLastCalledWith("/models");
    expect(buttonOf(row, "Default").hidden).toBe(false);

    buttonOf(row, "Default").click();
    expect(pathOf(row).value).toBe("");
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(buttonOf(row, "Default").hidden).toBe(true);
  });

  it("saves a typed path, trimmed", () => {
    const onChange = vi.fn();
    const row = optionControl(folder("Models", "Next to the app"), "/old", onChange);
    expect(pathOf(row).placeholder).toBe("Next to the app");
    pathOf(row).value = "  /new ";
    pathOf(row).dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledWith("/new");
  });

  it("keeps the folder when the dialog is cancelled, as it always is outside the app", async () => {
    const onChange = vi.fn();
    const row = optionControl(folder("Models"), "/kept", onChange);
    buttonOf(row, "Browse…").click();
    await settle();
    expect(pathOf(row).value).toBe("/kept");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports a dialog that fails, and keeps the folder", async () => {
    const error = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen = problems();
    const onChange = vi.fn();
    const row = optionControl(folder("Models"), "/kept", onChange, async () => Promise.reject(new Error("no dialog")));
    buttonOf(row, "Browse…").click();
    await settle();
    expect(seen.list).toEqual([{ title: "Couldn't open the folder picker", message: "no dialog", code: "FOLDER_PICKER" }]);
    seen.stop();
    expect(pathOf(row).value).toBe("/kept");
    expect(onChange).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("a secret option, when the credential store fails", () => {
  beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  const typeIn = (row: HTMLElement, value: string) => {
    const input = row.querySelector<HTMLInputElement>("input[type=password]")!;
    input.value = value;
    input.dispatchEvent(new Event("input"));
    return input;
  };

  it("saves on Enter, and says why it couldn't", async () => {
    const save = vi.fn(async () => Promise.reject(new Error("locked")));
    const seen = problems();
    const row = optionControl(secret("Token"), "", vi.fn(), undefined, { saved: async () => false, save });
    await settle();
    const input = typeIn(row, "abc");
    expect(buttonOf(row, "Save").disabled).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await settle();
    expect(save).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(save).toHaveBeenCalledWith("abc");
    expect(errorOf(row)).toBeNull();
    expect(seen.list).toEqual([{ title: "Couldn't save Token", message: "locked", code: "SECRET_SAVE" }]);
  });

  it("says what went wrong when the failure isn't an error", async () => {
    const seen = problems();
    const row = optionControl(secret("Token"), "", vi.fn(), undefined, { saved: async () => false, save: async () => Promise.reject("busy") });
    typeIn(row, "abc");
    buttonOf(row, "Save").click();
    await settle();
    expect(seen.list.map((p) => p.message)).toEqual(["busy"]);
  });

  it("says when it can't tell whether one is saved", async () => {
    const seen = problems();
    const row = optionControl(secret("Token"), "", vi.fn(), undefined, { saved: async () => Promise.reject(new Error("no keyring")), save: vi.fn() });
    await settle();
    expect(seen.list).toEqual([{ title: "Couldn't read the credential store", message: "no keyring", code: "SECRET_READ" }]);
    expect(row.querySelector<HTMLInputElement>("input[type=password]")?.placeholder).toBe("Unknown: the credential store can't be read");
  });

  it("says a required one is needed once removed", async () => {
    const row = optionControl(secret("Token", { required: true, placeholder: "Paste it here" }), "", vi.fn(), undefined, { saved: async () => true, save: async () => {} });
    await settle();
    expect(errorOf(row)).toBeNull();
    buttonOf(row, "Remove").click();
    await settle();
    expect(errorOf(row)).toBe("Required.");
    expect(row.querySelector<HTMLInputElement>("input")?.placeholder).toBe("Paste it here");
  });

  it("does nothing where there's no credential store to save to", async () => {
    const row = optionControl(secret("Token"), "", vi.fn());
    buttonOf(row, "Remove").click();
    await settle();
    expect(errorOf(row)).toBeNull();
    expect(row.querySelector(".secret-state")?.textContent).toBe("");
  });
});
