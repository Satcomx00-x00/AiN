// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mounted } from "../sdk/plugin";
import { MAX_TABS, tabs } from "./tabs";

/** A plugin with a tab, mounted. */
const tab = (id: string): Mounted => ({ plugin: { id, label: id, description: "", icon: "", slots: ["tab"], setup: () => ({}) }, widget: { panel: () => {} } }) as never;

/** Lays each tab out `width` px wide from the bar's 3 px inset, as an engine would; the bar's size changes are handed to `resized`. */
function laidOut(width: number) {
  let resized = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(onResize: () => void) {
        resized = onResize;
      }
      observe() {}
    },
  );
  const at = (el: HTMLElement) => [...(el.parentElement?.querySelectorAll("[role=tab]") ?? [])].indexOf(el);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "tab" ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    return 3 + at(this) * width;
  });
  return { resize: () => resized() };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the tab highlight", () => {
  it("sits under the selected tab as laid out, and follows when the bar is resized", () => {
    const engine = laidOut(23);
    const view = tabs([tab("a"), tab("b"), tab("c")], () => {}, "b");
    expect([view.bar.style.getPropertyValue("--x"), view.bar.style.getPropertyValue("--w")]).toEqual(["23px", "23px"]);
    view.select("c");
    expect(view.bar.style.getPropertyValue("--x")).toBe("46px");
    vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!).mockReturnValue(30);
    engine.resize();
    expect(view.bar.style.getPropertyValue("--w")).toBe("30px");
  });

  it("sits under More for the list and for a plugin from it", () => {
    laidOut(20);
    const all = Array.from({ length: MAX_TABS + 2 }, (_, i) => tab(`t${i}`));
    const view = tabs(all, () => {}, `t${MAX_TABS + 1}`);
    expect(view.bar.style.getPropertyValue("--x")).toBe(`${MAX_TABS * 20}px`);
    view.select("t0");
    view.bar.querySelector<HTMLElement>("#tab-more")!.click();
    expect([view.active(), view.bar.style.getPropertyValue("--x")]).toEqual([undefined, `${MAX_TABS * 20}px`]);
  });

  it("is left to its index while the bar isn't laid out", () => {
    const view = tabs([tab("a"), tab("b")], () => {}, "b");
    expect([view.bar.style.getPropertyValue("--i"), view.bar.style.getPropertyValue("--x")]).toEqual(["1", ""]);
  });
});
