// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Stage } from "../../sdk/greeting";

const { greetings } = await import(".");
const { HELLO_MS } = await import("./hello");
const { TYPEWRITER_TEXT } = await import("./typewriter");

/** The island's markup as the host builds it. */
function stage(): Stage {
  const island = document.createElement("div");
  island.id = "island";
  island.innerHTML = `<div class="surface"><div class="glance"></div></div>`;
  document.body.replaceChildren(island);
  return { island, surface: island.querySelector(".surface")!, glance: island.querySelector(".glance"), size: { width: 200, height: 32 } };
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

describe("the built-in startup animations", () => {
  it("have distinct, valid ids and labels, hello first (the default)", () => {
    const ids = greetings.map((g) => g.id);
    expect(ids[0]).toBe("hello");
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of greetings) {
      expect(g.id).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(g.label.trim()).not.toBe("");
    }
    // "none" means no animation in the settings.
    expect(ids).not.toContain("none");
  });

  describe.each(greetings.map((g) => [g.id, g] as const))("%s", (_, greeting) => {
    it("starts the pill as a drop of its height and ends it at its full width, untransformed", async () => {
      const calls = recordAnimations();
      const s = stage();
      await greeting.play(s);
      const pill = calls.find((c) => c.el === s.island)!;
      expect(pill.keyframes[0]).toMatchObject({ width: "32px" });
      expect(pill.keyframes.at(-1)).toMatchObject({ width: "200px" });
      expect(pill.keyframes.at(-1)?.transform ?? "none").toBe("none");
      // The pill's own style takes over once it's done, not a frozen last frame.
      expect(pill.options.fill).toBe("backwards");
    });

    it("hides the glances until the end, then shows them again", async () => {
      const calls = recordAnimations();
      const s = stage();
      await greeting.play(s);
      const glance = calls.find((c) => c.el === s.glance)!;
      expect(glance.keyframes[0]).toMatchObject({ opacity: 0 });
      expect(glance.keyframes.at(-1)).toMatchObject({ opacity: 1 });
      expect(glance.options.duration).toBe(calls.find((c) => c.el === s.island)!.options.duration);
    });

    it("keeps every keyframe offset in order, from 0 to 1", async () => {
      const calls = recordAnimations();
      await greeting.play(stage());
      for (const { keyframes } of calls) {
        const offsets = keyframes.map((k, i) => k.offset ?? (i === 0 ? 0 : i === keyframes.length - 1 ? 1 : null));
        expect(offsets).not.toContain(null);
        expect(offsets).toEqual([...offsets].sort((a, b) => a! - b!));
        expect(offsets[0]).toBe(0);
        expect(offsets.at(-1)).toBe(1);
      }
    });

    it("stays within the time the island gives it", async () => {
      const calls = recordAnimations();
      await greeting.play(stage());
      for (const { options } of calls) expect((options.duration as number) * (options.iterations ?? 1)).toBeLessThanOrEqual(3000);
    });

    it("leaves the pill as it found it, even when cancelled", async () => {
      recordAnimations(() => Promise.reject(new DOMException("cancelled", "AbortError")));
      const s = stage();
      await expect(greeting.play(s)).resolves.toBeUndefined();
      expect(s.surface.children).toHaveLength(1);
      expect(s.surface.firstElementChild).toBe(s.glance);
    });

    it("works without glances", async () => {
      recordAnimations();
      await expect(greeting.play({ ...stage(), glance: null })).resolves.toBeUndefined();
    });
  });
});

describe("hello", () => {
  it("shows a face while it greets, gone once it's over", async () => {
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => (finish = r));
    const calls = recordAnimations(() => done);
    const s = stage();
    const playing = greetings[0]!.play(s);
    const face = s.surface.querySelector(".hello-face");
    expect(face?.querySelectorAll(".eye")).toHaveLength(2);
    expect(face?.getAttribute("aria-hidden")).toBe("true");
    expect(calls.find((c) => c.el === s.island)!.options.duration).toBe(HELLO_MS);
    expect(calls.find((c) => c.el === s.island)!.keyframes[0]?.transform).toContain("translateY(-110%)");
    finish();
    await playing;
    expect(s.surface.querySelector(".hello-face")).toBeNull();
  });
});

describe("typewriter", () => {
  it("types its text one letter after the other, then erases it from the end", async () => {
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => (finish = r));
    const calls = recordAnimations(() => done);
    const s = stage();
    const playing = greetings.find((g) => g.id === "typewriter")!.play(s);
    const letters = [...s.surface.querySelectorAll(".typewriter-letter")];
    expect(letters.map((l) => l.textContent).join("")).toBe(TYPEWRITER_TEXT);
    const shownAt = (l: Element) => calls.find((c) => c.el === l)!.keyframes.find((k) => k.opacity === 1)!.offset as number;
    const goneAt = (l: Element) => [...calls.find((c) => c.el === l)!.keyframes].reverse().find((k) => k.opacity === 1)!.offset as number;
    const shown = letters.map(shownAt);
    const gone = letters.map(goneAt);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    expect(new Set(shown).size).toBe(letters.length);
    expect(gone).toEqual([...gone].sort((a, b) => b - a));
    // Every letter is all typed before the first one goes.
    expect(Math.max(...shown)).toBeLessThan(Math.min(...gone));
    finish();
    await playing;
    expect(s.surface.querySelector(".typewriter")).toBeNull();
  });
});

describe("sparkle", () => {
  it("twinkles its stars inside the pill, one after the other", async () => {
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => (finish = r));
    const calls = recordAnimations(() => done);
    const s = stage();
    const playing = greetings.find((g) => g.id === "sparkle")!.play(s);
    const stars = [...s.surface.querySelectorAll<HTMLElement>(".sparkle-star")];
    expect(stars.length).toBeGreaterThan(3);
    for (const star of stars) {
      expect(parseFloat(star.style.left)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(star.style.left)).toBeLessThanOrEqual(100);
      expect(star.querySelector("svg")).not.toBeNull();
    }
    const lit = stars.map((star) => calls.find((c) => c.el === star)!.keyframes.find((k) => k.opacity === 1)!.offset as number);
    expect(lit).toEqual([...lit].sort((a, b) => a - b));
    finish();
    await playing;
    expect(s.surface.querySelector(".sparkle-sky")).toBeNull();
  });
});

describe("boing", () => {
  it("bounces lower each time before it springs wide", async () => {
    const calls = recordAnimations();
    const s = stage();
    await greetings.find((g) => g.id === "boing")!.play(s);
    const frames = calls.find((c) => c.el === s.island)!.keyframes;
    const heights = frames
      .map((k) => /translateY\((-?\d+)%\)/.exec(String(k.transform))?.[1])
      .filter((y): y is string => y !== undefined && y !== "0")
      .map(Number);
    // -110 (from above the screen), then each bounce is smaller.
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(heights[0]).toBe(-110);
    // Narrow while it bounces, wide only at the end.
    const firstWide = frames.findIndex((k) => k.width === "200px");
    expect(frames.slice(0, firstWide).every((k) => k.width === "32px")).toBe(true);
  });
});
