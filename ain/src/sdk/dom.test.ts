// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const { animates, button, h, icon, odometer, roll, svg, tween } = await import("./dom");

afterEach(() => vi.restoreAllMocks());

/** Motion on or off, with Web Animations recorded. */
function motion(on: boolean) {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: !on } as MediaQueryList);
  return vi.spyOn(Element.prototype, "animate").mockImplementation(() => ({ finished: new Promise(() => {}) }) as unknown as Animation);
}

describe("h, button, svg and icon", () => {
  it("builds an element with attributes and children", () => {
    const el = h("div", { class: "row", "data-x": "1" }, "text", h("span", {}, "child"));
    expect(el.outerHTML).toBe('<div class="row" data-x="1">text<span>child</span></div>');
  });

  it("makes a button that runs its action", () => {
    const onClick = vi.fn();
    const b = button("Go", onClick, { class: "primary" });
    b.click();
    expect([b.type, b.className, b.textContent, onClick.mock.calls.length]).toEqual(["button", "primary", "Go", 1]);
  });

  it("makes 16 px stroke icons from SVG markup", () => {
    const i = icon(`<circle cx="8" cy="8" r="6"/>`);
    expect([i.getAttribute("viewBox"), i.getAttribute("class"), i.querySelector("circle")?.getAttribute("r")]).toEqual(["0 0 16 16", "icon", "6"]);
    expect(svg("0 0 4 4", "", "x").getAttribute("aria-hidden")).toBe("true");
  });

  it("says whether transitions run", () => {
    expect(animates("0s, 0.3s")).toBe(true);
    expect(animates("0s")).toBe(false);
  });
});

describe("odometer", () => {
  const texts = (el: HTMLElement) => [...el.children].map((c) => c.lastElementChild?.textContent).join("");

  it("draws each character in its own cell, marking separators", () => {
    motion(true);
    const el = h("span");
    odometer(el, "09:41");
    expect(texts(el)).toBe("09:41");
    expect([...el.children].map((c) => c.className)).toEqual(["odo", "odo", "odo odo-sep", "odo", "odo"]);
  });

  it("rolls only the characters that changed, the rightmost first", () => {
    const animate = motion(true);
    const el = h("span");
    odometer(el, "09:41");
    odometer(el, "09:52");
    expect(texts(el)).toBe("09:52");
    // Two cells changed: each slides its old character out and the new one in.
    expect(animate).toHaveBeenCalledTimes(4);
    const delays = animate.mock.calls.map(([, o]) => (o as KeyframeAnimationOptions).delay);
    expect(delays).toEqual([35, 35, 0, 0]);
  });

  it("does nothing for the same text, and swaps without motion when asked to", () => {
    const animate = motion(false);
    const el = h("span");
    odometer(el, "1:00");
    odometer(el, "1:00");
    odometer(el, "1:01");
    expect([texts(el), animate.mock.calls.length]).toEqual(["1:01", 0]);
  });

  it("rebuilds the cells when the length changes", () => {
    const animate = motion(true);
    const el = h("span");
    odometer(el, "9:59");
    odometer(el, "10:00");
    expect([texts(el), el.children.length, animate.mock.calls.length]).toEqual(["10:00", 5, 0]);
  });
});

describe("roll", () => {
  it("sets the text, and keeps it when nothing changed", () => {
    motion(false);
    const el = h("span");
    roll(el, "42%");
    roll(el, "42%");
    expect(el.textContent).toBe("42%");
    roll(el, "43%");
    expect(el.textContent).toBe("43%");
  });

  it("slides in only the characters that changed, not the first text", () => {
    const animate = motion(true);
    const el = h("span");
    roll(el, "42%");
    expect(animate).not.toHaveBeenCalled();
    roll(el, "47%");
    expect(animate.mock.contexts.map((c) => (c as Element).textContent)).toEqual(["7"]);
  });
});

describe("tween", () => {
  it("shows the first value at once, then counts to the next one", async () => {
    motion(true);
    let frame: FrameRequestCallback = () => {};
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => ((frame = cb), 1));
    const el = h("span");
    const fmt = (n: number) => String(Math.round(n));
    tween(el, 10, fmt, 600);
    expect(el.textContent).toBe("10");
    const start = performance.now();
    tween(el, 20, fmt, 600);
    frame(start + 300);
    const mid = Number(el.textContent);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(20);
    frame(start + 600);
    expect(el.textContent).toBe("20");
  });

  it("jumps straight to the value under reduced motion", () => {
    motion(false);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const el = h("span");
    tween(el, 1, String);
    tween(el, 5, String);
    expect([el.textContent, raf.mock.calls.length]).toEqual(["5", 0]);
  });

  it("starts nothing new for the value it is already heading to", () => {
    motion(true);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const el = h("span");
    tween(el, 1, String);
    tween(el, 5, String);
    tween(el, 5, String);
    expect(raf).toHaveBeenCalledTimes(1);
  });
});
