// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const { HELLO_MS, hello } = await import("./hello");

/** The island's markup as the host builds it. */
function island() {
  const el = document.createElement("div");
  el.id = "island";
  el.innerHTML = `<div class="surface"><div class="glance"></div></div>`;
  document.body.replaceChildren(el);
  return el;
}

type Call = { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions };

/** Records animations; `end` decides how each one finishes. */
function recordAnimations(end: () => Promise<unknown> = () => Promise.resolve()) {
  const calls: Call[] = [];
  vi.spyOn(Element.prototype, "animate").mockImplementation(function (this: Element, keyframes, options) {
    calls.push({ el: this, keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions });
    return { finished: end() } as unknown as Animation;
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe("the hello at startup", () => {
  it("doesn't move at all for people who ask for reduced motion", async () => {
    const calls = recordAnimations();
    const el = island();
    await hello(el, { width: 200, height: 32 }, false);
    expect(calls).toHaveLength(0);
    expect(el.querySelector(".hello-face")).toBeNull();
  });

  it("grows the pill from a drop of its height to its full width, from above the screen", async () => {
    const calls = recordAnimations();
    const el = island();
    await hello(el, { width: 200, height: 32 }, true);
    const pill = calls.find((c) => c.el === el)!;
    expect(pill.keyframes[0]).toMatchObject({ width: "32px", transform: expect.stringContaining("translateY(-110%)") });
    expect(pill.keyframes.at(-1)).toMatchObject({ width: "200px", transform: "none" });
    expect(pill.options.duration).toBe(HELLO_MS);
  });

  it("shows a face while greeting, hides the glances until it's gone, then cleans up", async () => {
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => (finish = r));
    const calls = recordAnimations(() => done);
    const el = island();
    const greeting = hello(el, { width: 200, height: 32 }, true);
    const face = el.querySelector(".hello-face");
    expect(face?.querySelectorAll(".eye")).toHaveLength(2);
    expect(face?.getAttribute("aria-hidden")).toBe("true");
    const glance = calls.find((c) => c.el.classList.contains("glance"))!;
    expect(glance.keyframes[0]).toMatchObject({ opacity: 0 });
    expect(glance.keyframes.at(-1)).toMatchObject({ opacity: 1 });

    finish();
    await greeting;
    expect(el.querySelector(".hello-face")).toBeNull();
  });

  it("still removes the face when its animations are cancelled", async () => {
    recordAnimations(() => Promise.reject(new DOMException("cancelled", "AbortError")));
    const el = island();
    await expect(hello(el, { width: 200, height: 32 }, true)).resolves.toBeUndefined();
    expect(el.querySelector(".hello-face")).toBeNull();
  });

  it("keeps every keyframe offset in order, within the greeting", async () => {
    const calls = recordAnimations();
    await hello(island(), { width: 200, height: 32 }, true);
    for (const { keyframes } of calls) {
      const offsets = keyframes.map((k) => k.offset as number);
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
      expect(offsets[0]).toBe(0);
      expect(offsets.at(-1)).toBe(1);
    }
  });
});
