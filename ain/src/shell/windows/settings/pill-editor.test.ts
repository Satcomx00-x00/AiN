// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { AnyPlugin } from "../../../sdk/plugin";
import type { Layout } from "../../placement";
import { edgeSpeed, placed, previewGlance, removed, scrollerOf, sideOf, toggled, zonesOf } from "./pill-editor";

const layout: Layout = { glance: { left: ["clock"], right: ["media", "stats"] }, tabs: ["media", "clock"] };
const plugin = (sample?: AnyPlugin["sample"]): AnyPlugin => ({ id: "clock", label: "Clock", description: "", icon: "<circle/>", slots: ["glance"], setup: () => ({}), ...(sample ? { sample } : {}) });
const look = { perSide: 1, icons: [], idle: [] };

describe("Settings → Pill: placing widgets", () => {
  it("says where a widget is", () => {
    expect(zonesOf(layout, "media")).toEqual(["right", "tabs"]);
    expect(sideOf(layout, "clock")).toBe("left");
    expect(sideOf(layout, "timer")).toBeNull();
  });

  it("adds a widget from the list at the spot it's dropped", () => {
    expect(placed(layout, "timer", null, "right", 1).glance.right).toEqual(["media", "timer", "stats"]);
    expect(placed(layout, "timer", null, "tabs", 99).tabs).toEqual(["media", "clock", "timer"]);
  });

  it("moves a widget from one end to the other, keeping its tab", () => {
    const next = placed(layout, "clock", "left", "right", 0);
    expect([next.glance.left, next.glance.right, next.tabs]).toEqual([[], ["clock", "media", "stats"], ["media", "clock"]]);
  });

  it("keeps a widget on one end only, even when added from the list", () => expect(placed(layout, "stats", null, "left", 0).glance).toEqual({ left: ["stats", "clock"], right: ["media"] }));

  it("reorders the tabs, and moves a glance into them keeping it on the pill", () => {
    expect(placed(layout, "clock", "tabs", "tabs", 0).tabs).toEqual(["clock", "media"]);
    expect(placed(layout, "clock", "left", "tabs", 0)).toEqual({ glance: { left: [], right: ["media", "stats"] }, tabs: ["clock", "media"] });
  });

  it("moves a tab onto the pill, and reorders within a spot", () => {
    const fromTabs = placed(layout, "media", "tabs", "left", 1);
    expect([fromTabs.glance.left, fromTabs.glance.right, fromTabs.tabs]).toEqual([["clock", "media"], ["stats"], ["clock"]]);
    expect(placed(layout, "stats", "right", "right", 0).glance.right).toEqual(["stats", "media"]);
  });

  it("removes a widget from a spot, and toggles it in a list", () => {
    expect(removed(layout, "media", ["right"])).toEqual({ glance: { left: ["clock"], right: ["stats"] }, tabs: ["media", "clock"] });
    expect(toggled(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "a", true)).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "a", false)).toEqual(["b"]);
  });
});

describe("Settings → Pill: scrolling while dragging", () => {
  it("scrolls toward the edge the pointer is near, faster nearer it", () => {
    expect([edgeSpeed(400, 0, 800), edgeSpeed(0, 0, 800), edgeSpeed(24, 0, 800), edgeSpeed(-50, 0, 800)]).toEqual([0, -14, -7, -14]);
    expect([edgeSpeed(800, 0, 800), edgeSpeed(776, 0, 800), edgeSpeed(900, 0, 800)]).toEqual([14, 7, 14]);
  });

  it("scrolls the nearest ancestor that scrolls, else the document", () => {
    const page = document.createElement("div");
    page.style.overflowY = "auto";
    const el = page.appendChild(document.createElement("div")).appendChild(document.createElement("span"));
    document.body.append(page);
    expect([scrollerOf(el), scrollerOf(page)]).toEqual([page, document.documentElement]);
    page.remove();
  });
});

describe("Settings → Pill: the preview", () => {
  it("shows a widget's sample with its options, or its label", () => {
    expect(previewGlance(plugin((o) => ({ text: String((o as { show: string }).show) })), { show: "date" }, look)).toEqual({ text: "date" });
    expect(previewGlance(plugin(), {}, look)).toEqual({ text: "Clock" });
  });

  it("adds the widget's icon when it's dressed with it", () => expect(previewGlance(plugin(), {}, { ...look, icons: ["clock"] })).toEqual({ text: "Clock", icon: "<circle/>" }));
});

describe("Settings → Pill: the editor", async () => {
  const { afterEach, vi } = await import("vitest");
  const { pillEditor } = await import("./pill-editor");
  const { choice, secret, toggle } = await import("../../../sdk/options");
  type Editor = Parameters<typeof pillEditor>[0];

  const widget = (id: string, slots: AnyPlugin["slots"], options?: AnyPlugin["options"]): AnyPlugin => ({ id, label: id.toUpperCase(), description: "", icon: "<circle/>", slots, ...(options ? { options } : {}), setup: () => ({}) });
  const plugins = [
    widget("clock", ["glance", "tab"], {
      format: choice("Time format", "24", [["24", "24-hour"]]),
      show: { ...choice("On the pill", "time", [["time", "Time"]]), pill: true },
      token: secret("Token"),
    }),
    widget("media", ["glance", "tab"]),
    widget("stats", ["glance", "tab"]),
    widget("notes", ["tab"], { big: toggle("Big", false) }),
    widget("shot", []),
  ];

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function editor(over: Partial<Editor> = {}) {
    const spies = { select: vi.fn(), setLayout: vi.fn<(layout: Layout) => void>(), setLook: vi.fn(), setWidth: vi.fn(), openWidget: vi.fn() };
    const ed: Editor = {
      plugins,
      layout: { glance: { left: ["clock", "gone"], right: ["media", "stats", "gone"] }, tabs: ["media", "clock", "gone"] },
      look: { perSide: 1, icons: [], idle: [] },
      width: 200,
      selected: null,
      values: () => ({}),
      optionControl: (_: AnyPlugin, key: string) => Object.assign(document.createElement("div"), { className: `opt opt-${key}` }),
      ...over,
      ...spies,
    };
    const [root] = pillEditor(ed) as [HTMLElement];
    document.body.append(root);
    const $ = <E extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
    const field = (label: string) => [...root.querySelectorAll<HTMLElement>(".field")].find((f) => f.querySelector(".field-label")?.textContent === label);
    const press = (label: string, within: ParentNode = root) => [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!.click();
    return { ed: spies, root, $, field, press };
  }

  const pointer = (type: string, at: Element | Window, x: number, y: number, button = 0) =>
    at.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button }));
  /** Drags `item` onto `zone` (or nothing), as the pointer would. */
  function drag(item: Element, zone: Element | null, end: "pointerup" | "pointercancel" = "pointerup") {
    vi.spyOn(document, "elementFromPoint").mockReturnValue(zone);
    pointer("pointerdown", item, 0, 0);
    pointer("pointermove", window, 2, 2);
    pointer("pointermove", window, 40, 40);
    pointer("pointermove", window, 42, 42);
    pointer(end, window, 42, 42);
  }

  it("previews the pill, lists each side in order and the tabs, skipping widgets it doesn't know", () => {
    const { root } = editor();
    const ids = (sel: string) => [...root.querySelectorAll<HTMLElement>(`${sel} [data-drag]`)].map((el) => el.dataset.drag);
    expect([ids(".pp-end[data-zone=left]"), ids(".pp-end[data-zone=right]"), ids(".pp-tabs")]).toEqual([["clock"], ["media"], ["media", "clock"]]);
    expect([ids(".side-list[data-zone=left]"), ids(".side-list[data-zone=right]")]).toEqual([["clock"], ["media", "stats"]]);
    expect(ids(".pill-shelf")).toEqual(["clock", "media", "stats", "notes"]);
  });

  it("names each side, numbers its widgets, and marks where waiting their turn begins", () => {
    const { root, $ } = editor();
    expect([...root.querySelectorAll(".side-card h2")].map((el) => el.textContent)).toEqual(["Left side", "Right side"]);
    const right = [...$(".side-list[data-zone=right]").children].map((el) => (el.classList.contains("side-split") ? "—" : `${el.querySelector(".side-n")?.textContent} ${el.querySelector(".side-name")?.textContent}`));
    expect(right).toEqual(["1 MEDIA", "—", "2 STATS"]);
    expect($(".side-list[data-zone=right] [data-drag=stats]").dataset.waiting).toBe("true");
    // Nothing waits on the left: no line.
    expect($(".side-list[data-zone=left] .side-split")).toBeNull();
  });

  it("asks to select a widget until one is, and outlines the one selected", () => {
    expect(editor().$(".pill-inspector").textContent).toBe("Select a widget.");
    const { root } = editor({ selected: "clock" });
    // On the pill, in its side's list, and in the tabs.
    expect([...root.querySelectorAll(".selected")].map((el) => (el as HTMLElement).dataset.drag)).toEqual(["clock", "clock", "clock"]);
  });

  it("sets the width and how many glances each end shows", () => {
    const { ed, $, field, press } = editor();
    const range = $<HTMLInputElement>("input[type=range]");
    range.value = "260";
    range.dispatchEvent(new Event("input"));
    expect([ed.setWidth.mock.calls[0], $(".pp").style.getPropertyValue("--pill-w")]).toEqual([[260], "260px"]);
    press("3", field("Per side"));
    expect(ed.setLook).toHaveBeenCalledWith({ perSide: 3, icons: [], idle: [] });
  });

  it("moves a widget between ends, off the pill, along its end, and in and out of the tabs", () => {
    const { ed, field, press } = editor({ selected: "media" });
    press("Left", field("Side"));
    expect(ed.setLayout).toHaveBeenLastCalledWith(expect.objectContaining({ glance: { left: ["clock", "gone", "media"], right: ["stats", "gone"] } }));
    press("Off", field("Side"));
    expect(ed.setLayout.mock.lastCall?.[0].glance.right).toEqual(["stats", "gone"]);
    expect(field("Side")!.querySelector("button")).toBeDefined();
    expect(field("Position")!.querySelector<HTMLButtonElement>("[aria-label='Move left']")!.disabled).toBe(true);
    press("Move right", field("Position"));
    expect(ed.setLayout.mock.lastCall?.[0].glance.right).toEqual(["stats", "media", "gone"]);
    press("In the tabs", field("In the tabs"));
    expect(ed.setLayout.mock.lastCall?.[0].tabs).toEqual(["clock", "gone"]);
  });

  it("says a widget past the number per side waits, and can't move past the end", () => {
    const { ed, field, press } = editor({ selected: "stats", layout: { glance: { left: [], right: ["media", "stats"] }, tabs: [] } });
    expect(field("Position")!.querySelector(".field-hint")?.textContent).toBe("Waits for the ones before it.");
    expect(field("Position")!.querySelector<HTMLButtonElement>("[aria-label='Move right']")!.disabled).toBe(true);
    press("Move left", field("Position"));
    expect(ed.setLayout.mock.lastCall?.[0].glance.right).toEqual(["stats", "media"]);
    press("In the tabs", field("In the tabs"));
    expect(ed.setLayout.mock.lastCall?.[0].tabs).toEqual(["stats"]);
  });

  it("dresses a glance with its icon or keeps it while idle", () => {
    const { ed, field, press } = editor({ selected: "clock", look: { perSide: 1, icons: ["clock"], idle: [] } });
    press("Icon", field("Icon"));
    expect(ed.setLook).toHaveBeenLastCalledWith({ perSide: 1, icons: [], idle: [] });
    press("When idle", field("When idle"));
    expect(ed.setLook).toHaveBeenLastCalledWith({ perSide: 1, icons: ["clock"], idle: ["clock"] });
  });

  it("offers a widget's options, its pill-only ones while on the pill, never its secrets, and all of them on its page", () => {
    const on = editor({ selected: "clock" });
    expect([...on.root.querySelectorAll<HTMLElement>(".opt")].map((o) => o.className)).toEqual(["opt opt-format", "opt opt-show"]);
    on.press("All options");
    expect(on.ed.openWidget).toHaveBeenCalledWith("clock");
    const off = editor({ selected: "clock", layout: { glance: { left: [], right: [] }, tabs: [] } });
    expect([...off.root.querySelectorAll<HTMLElement>(".opt")].map((o) => o.className)).toEqual(["opt opt-format"]);
    expect([off.field("Position"), off.field("Icon")]).toEqual([undefined, undefined]);
  });

  it("keeps a tab-only widget off the pill", () => {
    const { ed, field, press } = editor({ selected: "notes" });
    expect(field("Side")).toBeUndefined();
    press("In the tabs", field("In the tabs"));
    expect(ed.setLayout.mock.lastCall?.[0].tabs).toEqual(["media", "clock", "gone", "notes"]);
  });

  it("selects on a press, from the pill, the tabs or the widget list", () => {
    const { ed, $ } = editor();
    pointer("pointerdown", $(".pp-tab"), 0, 0);
    pointer("pointerup", window, 0, 0);
    expect(ed.select).toHaveBeenLastCalledWith("media");
    pointer("pointerdown", $(".pill-widget[data-drag=stats]"), 0, 0);
    pointer("pointerup", window, 0, 0);
    expect(ed.select).toHaveBeenCalledTimes(1);
    $(".pill-widget[data-drag=stats]").click();
    expect(ed.select).toHaveBeenLastCalledWith("stats");
  });

  it("drops a widget from the list onto an end, before what's under the pointer", () => {
    const { ed, $ } = editor();
    const left = $(".pp-end[data-zone=left]");
    vi.spyOn(left.querySelector("[data-drag]")!, "getBoundingClientRect").mockReturnValue({ left: 30, width: 40 } as DOMRect);
    drag($(".pill-widget[data-drag=stats]"), left);
    expect(ed.setLayout.mock.lastCall?.[0].glance).toEqual({ left: ["stats", "clock", "gone"], right: ["media", "gone"] });
    expect(ed.select).toHaveBeenLastCalledWith("stats");
  });

  it("drops at the end of a side's list and into the tabs, after the rest", () => {
    const { ed, $ } = editor();
    drag($(".pp-end[data-zone=left] [data-drag]"), $(".side-list[data-zone=right]"));
    expect(ed.setLayout.mock.lastCall?.[0].glance).toEqual({ left: ["gone"], right: ["media", "stats", "clock", "gone"] });
    drag($(".pill-widget[data-drag=clock]"), $(".pp-end[data-zone=left]"));
    expect(ed.setLayout.mock.lastCall?.[0].glance.left).toEqual(["clock", "gone"]);
    drag($(".pill-widget[data-drag=notes]"), $(".pp-tabs"));
    expect(ed.setLayout.mock.lastCall?.[0].tabs).toEqual(["media", "clock", "notes", "gone"]);
  });

  it("drops into a side's list behind what the pill shows, so it waits its turn", () => {
    const { ed, $ } = editor();
    drag($(".pill-widget[data-drag=stats]"), $(".side-list[data-zone=left]"));
    expect(ed.setLayout.mock.lastCall?.[0].glance).toEqual({ left: ["clock", "stats", "gone"], right: ["media", "gone"] });
  });

  it("drops onto an end that shows nothing, at its start", () => {
    const { ed, $ } = editor({ layout: { glance: { left: ["gone"], right: [] }, tabs: [] } });
    expect($(".pp-end[data-zone=left]").childElementCount).toBe(0);
    drag($(".pill-widget[data-drag=stats]"), $(".pp-end[data-zone=left]"));
    expect(ed.setLayout.mock.lastCall?.[0].glance.left).toEqual(["stats", "gone"]);
  });

  it("takes a widget off the pill when dropped back on the list, and shows where to drop it meanwhile", () => {
    const { ed, root, $ } = editor();
    vi.spyOn(document, "elementFromPoint").mockReturnValue($(".pill-remove"));
    pointer("pointerdown", $(".pp-tab"), 0, 0);
    pointer("pointermove", window, 40, 40);
    expect([root.classList.contains("dragging"), root.dataset.from, $(".pill-remove").classList.contains("over")]).toEqual([true, "tabs", true]);
    pointer("pointerup", window, 40, 40);
    expect(ed.setLayout.mock.lastCall?.[0].tabs).toEqual(["clock", "gone"]);
    expect([root.classList.contains("dragging"), document.querySelector(".pp-ghost")]).toEqual([false, null]);
  });

  it("scrolls the page while a drag is near its edge, and stops when it leaves it or ends", () => {
    const { $ } = editor();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    const stop = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", stop);
    const page = document.documentElement;
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue({ top: -100, bottom: 5000 } as DOMRect);
    const scrollBy = vi.fn();
    page.scrollBy = scrollBy as typeof page.scrollBy;
    vi.spyOn(document, "elementFromPoint").mockReturnValue(null);
    pointer("pointerdown", $(".pill-widget[data-drag=stats]"), 300, 300);
    pointer("pointermove", window, 300, 2);
    pointer("pointermove", window, 300, 0);
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    frames.shift()!(0);
    expect(scrollBy.mock.calls).toEqual([[0, -14], [0, -14]]);
    pointer("pointermove", window, 300, 300);
    frames.shift()!(0);
    expect([scrollBy.mock.calls.length, frames.length]).toEqual([2, 0]);
    pointer("pointermove", window, 300, innerHeight);
    expect(frames).toHaveLength(1);
    pointer("pointerup", window, 300, innerHeight);
    expect(stop).toHaveBeenCalledWith(1);
    vi.unstubAllGlobals();
  });

  it("ignores drops that change nothing or can't be done", () => {
    const { ed, root, $ } = editor();
    drag($(".pill-widget[data-drag=stats]"), $(".pill-shelf"));
    drag($(".pill-widget[data-drag=notes]"), $(".pp-end[data-zone=left]"));
    drag($(".pill-widget[data-drag=stats]"), null);
    drag($(".pill-widget[data-drag=stats]"), document.body);
    drag($(".pill-widget[data-drag=stats]"), $(".pp-tabs"), "pointercancel");
    pointer("pointerdown", $(".pp-tab"), 0, 0, 2);
    pointer("pointerdown", $(".pill-stage"), 0, 0);
    pointer("pointerup", window, 0, 0);
    const outside = document.createElement("div");
    outside.dataset.zone = "left";
    document.body.append(outside);
    drag($(".pill-widget[data-drag=stats]"), outside);
    expect([ed.setLayout, ed.select].map((f) => f.mock.calls.length)).toEqual([0, 0]);
    expect(root.querySelector(".pp-caret")).toBeNull();
  });
});
