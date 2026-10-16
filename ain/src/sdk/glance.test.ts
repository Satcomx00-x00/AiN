// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const { glanceSlot } = await import("./glance");

afterEach(() => vi.restoreAllMocks());

/** A glance spot, with motion off unless asked for. */
function slot(motion = false) {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: !motion } as MediaQueryList);
  const animate = vi.spyOn(Element.prototype, "animate").mockImplementation(() => ({ finished: Promise.resolve() }) as unknown as Animation);
  const s = glanceSlot();
  const part = <T extends Element = HTMLElement>(sel: string) => s.el.querySelector<T & HTMLElement>(sel)!;
  return { ...s, animate, part };
}

describe("a glance spot", () => {
  it("shows the text, its tone and its mark", () => {
    const s = slot();
    s.draw({ text: "Discord", mark: "mic", tone: "alert" }, "privacy");
    expect(s.part(".g-text").textContent).toBe("Discord");
    expect(s.el.dataset.tone).toBe("alert");
    expect(s.part(".mark").dataset.kind).toBe("mic");
  });

  it("shows a ring only for progress, and a level bar only for a level", () => {
    const s = slot();
    s.draw({ text: "04:12", progress: 0.7 });
    expect([s.part(".mini-ring").style.display, s.part(".mini-ring").style.getPropertyValue("--p")]).toEqual(["", "0.7"]);
    expect(s.part(".g-bar").hidden).toBe(true);
    s.draw({ text: "64", level: 0.64 });
    expect(s.part(".mini-ring").style.display).toBe("none");
    expect([s.part(".g-bar").hidden, s.part(".g-bar").style.getPropertyValue("--p")]).toEqual([false, "0.64"]);
  });

  it("draws a sparkline from recent values", () => {
    const s = slot();
    s.draw({ text: "62%", spark: [10, 50, 90] });
    expect(s.part(".mini-spark").style.display).toBe("");
    expect(s.part("polyline").getAttribute("points")).toMatch(/\d/);
    s.draw({ text: "62%" });
    expect(s.part(".mini-spark").style.display).toBe("none");
  });

  it("shows art only when given, and doesn't reload the same picture", () => {
    const s = slot();
    const art = s.part<HTMLImageElement>(".g-art");
    s.draw({ text: "Song", art: "a.png" });
    expect([art.hidden, art.getAttribute("src")]).toEqual([false, "a.png"]);
    const setSrc = vi.spyOn(art, "src", "set");
    s.draw({ text: "Song", art: "a.png" });
    expect(setSrc).not.toHaveBeenCalled();
    s.draw({ text: "Song" });
    expect(art.hidden).toBe(true);
  });

  it("clears everything for nothing to say", () => {
    const s = slot();
    s.draw({ text: "04:12", progress: 0.5, mark: "rec", tone: "muted", art: "a.png", level: 1 });
    s.draw(null);
    expect(s.part(".g-text").textContent).toBe("");
    expect([s.el.dataset.tone, s.part(".mark").dataset.kind]).toEqual(["", ""]);
    expect([s.part(".g-art").hidden, s.part(".g-bar").hidden, s.part(".mini-ring").style.display]).toEqual([true, true, "none"]);
  });

  it("pops in when someone else starts speaking, not on every update", () => {
    const s = slot(true);
    s.draw({ text: "00:41" }, "clock");
    s.draw({ text: "00:42" }, "clock");
    expect(s.animate.mock.contexts.filter((el) => el === s.el)).toHaveLength(1);
    s.draw({ text: "Song" }, "media");
    expect(s.animate.mock.contexts.filter((el) => el === s.el)).toHaveLength(2);
  });

  it("doesn't pop in when motion should be reduced", () => {
    const s = slot(false);
    s.draw({ text: "00:41" }, "clock");
    s.draw({ text: "Song" }, "media");
    expect(s.animate.mock.contexts.filter((el) => el === s.el)).toHaveLength(0);
  });
});
