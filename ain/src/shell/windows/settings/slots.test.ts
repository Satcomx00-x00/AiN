// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { AnyPlugin } from "../../../sdk/plugin";

const { move, slotList } = await import("./slots");

const plugin = (id: string): AnyPlugin => ({ id, label: id.toUpperCase(), description: "", icon: "", slots: ["glance"], setup: () => ({}) });
const candidates = ["clock", "timer", "media"].map(plugin);

function list(ids: string[], hint?: string) {
  const onChange = vi.fn();
  const el = slotList({ title: "Left", ids, candidates, onChange, ...(hint ? { hint } : {}) });
  const rows = () => [...el.querySelectorAll<HTMLLIElement>("li")];
  const action = (label: string) => el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  return { el, onChange, rows, action, add: el.querySelector<HTMLSelectElement>("select")! };
}

describe("move", () => {
  it("moves an item to a new index", () => expect(move(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]));
  it("keeps the index within the list", () => {
    expect(move(["a", "b", "c"], 2, 9)).toEqual(["a", "b", "c"]);
    expect(move(["a", "b", "c"], 1, -3)).toEqual(["b", "a", "c"]);
  });
  it("leaves the list as it was for an index that holds nothing", () => expect(move(["a"], 5, 0)).toEqual(["a"]));
  it("doesn't change the list it was given", () => {
    const ids = ["a", "b"];
    move(ids, 0, 1);
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("a placement's list in Settings → Layout", () => {
  it("shows its title, hint and each widget by name", () => {
    const l = list(["timer", "clock"], "First with something to say wins.");
    expect(l.el.querySelector("h2")?.textContent).toBe("Left");
    expect(l.el.querySelector(".card-head p")?.textContent).toBe("First with something to say wins.");
    expect(l.rows().map((r) => r.querySelector(".slot-name")?.textContent)).toEqual(["TIMER", "CLOCK"]);
  });

  it("names a widget it doesn't know, e.g. from a plugin that was removed", () => {
    const l = list(["gone"]);
    expect(l.rows()[0]?.querySelector(".slot-name")?.textContent).toBe('Unknown "gone"');
    expect(l.rows()[0]?.dataset.unknown).toBe("true");
  });

  it("moves a widget up or down, and can't move past the ends", () => {
    const l = list(["clock", "timer", "media"]);
    expect([l.action("Move CLOCK up").disabled, l.action("Move MEDIA down").disabled]).toEqual([true, true]);
    l.action("Move TIMER up").click();
    l.action("Move TIMER down").click();
    expect(l.onChange.mock.calls).toEqual([[["timer", "clock", "media"]], [["clock", "media", "timer"]]]);
  });

  it("removes a widget", () => {
    const l = list(["clock", "timer"]);
    l.action("Remove CLOCK").click();
    expect(l.onChange).toHaveBeenCalledWith(["timer"]);
  });

  it("reorders by drag and drop", () => {
    const l = list(["clock", "timer", "media"]);
    const [first, , last] = l.rows();
    first?.dispatchEvent(new Event("dragstart"));
    expect(first?.classList.contains("dragging")).toBe(true);
    last?.dispatchEvent(new Event("dragover", { cancelable: true }));
    expect(last?.classList.contains("over")).toBe(true);
    last?.dispatchEvent(new Event("drop", { cancelable: true }));
    expect(l.onChange).toHaveBeenCalledWith(["timer", "media", "clock"]);
    expect(last?.classList.contains("over")).toBe(false);
  });

  it("ignores a drop on the row being dragged", () => {
    const l = list(["clock", "timer"]);
    const [first] = l.rows();
    first?.dispatchEvent(new Event("dragstart"));
    first?.dispatchEvent(new Event("drop", { cancelable: true }));
    first?.dispatchEvent(new Event("dragend"));
    expect(l.onChange).not.toHaveBeenCalled();
    expect(first?.classList.contains("dragging")).toBe(false);
  });

  it("offers only the widgets not placed yet, and adds the one picked at the end", () => {
    const l = list(["clock"]);
    expect([...l.add.options].map((o) => o.value)).toEqual(["", "timer", "media"]);
    l.add.value = "media";
    l.add.dispatchEvent(new Event("change"));
    expect(l.onChange).toHaveBeenCalledWith(["clock", "media"]);
  });

  it("says when every widget is placed, and when none is", () => {
    const full = list(["clock", "timer", "media"]);
    expect([full.add.disabled, full.add.options[0]?.textContent]).toEqual([true, "Everything is here"]);
    expect(list([]).el.querySelector(".slot-empty")?.textContent).toBe("Nothing here yet.");
  });
});
