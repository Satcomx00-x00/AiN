// @vitest-environment happy-dom
/**
 * The island as a whole: the real app, its built-in widgets, styles and startup animations, driven
 * through a fake system (see harness.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { TRACK, advance, environment, restore, startIsland, system } from "./harness";

afterEach(restore);

describe("starting up", () => {
  it("plays the startup animation, then shows the time and the CPU load on the pill", async () => {
    const { animations } = environment();
    const sys = system();
    const island = await startIsland(sys);
    expect(animations.some((a) => a.el === island.el)).toBe(true);
    await advance(1000);
    expect(island.glances()).toEqual(["09:41", "42%"]);
    expect(island.size()).toEqual({ width: "200px", height: "32px" });
    expect(sys.recorded.regions[0]).toEqual({ width: 220, height: 32 });
    expect(sys.recorded.rules).toEqual([[null, 760]]);
  });

  it("skips the startup animation for people who ask for reduced motion", async () => {
    const { animations } = environment({ reducedMotion: true });
    const island = await startIsland(system());
    expect(animations.filter((a) => a.el === island.el)).toEqual([]);
  });

  it("registers the shortcuts of the built-in features", async () => {
    environment();
    const sys = system();
    await startIsland(sys);
    expect(Object.keys(sys.recorded.bound.at(-1) ?? {})).toContain("clipboard.history");
  });
});

describe("what the pill shows", () => {
  it("follows the music: the track widens the pill, and it settles back when the music stops", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    sys.push.track(TRACK);
    await advance(1000);
    expect(island.glances()[1]).toBe("Midnight City");
    expect(island.el.dataset.wide).toBe("true");
    expect(island.size().width).toBe("296px");
    sys.push.track(null);
    await advance(1000);
    expect(island.glances()[1]).toBe("42%");
    expect(island.size().width).toBe("200px");
  });

  it("shows a volume change for a moment, then goes back", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    await advance(2000);
    sys.push.output({ level: 0.74, muted: false, device: "Speakers" } as never);
    await advance(1000);
    expect(island.glances()[1]).toBe("74%");
    await advance(2000);
    expect(island.glances()[1]).toBe("42%");
  });

  it("keeps showing who uses the microphone, over the music", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    sys.push.track(TRACK);
    sys.push.usage({ mic: ["Discord"], camera: [] });
    await advance(1000);
    expect(island.glances()[1]).toBe("Discord");
    expect(island.marks()).toEqual(["", "mic"]);
  });
});

describe("opening and closing", () => {
  it("opens on hover, below the pill, and folds back once the pointer leaves", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    await island.hover();
    expect(island.el.dataset.open).toBe("true");
    expect(island.size()).toEqual({ width: "420px", height: "188px" });
    // The input region grew before the pill did.
    expect(sys.recorded.regions.at(-1)).toEqual({ width: 420 + 2 * (10 + 16), height: 188 + 16 });
    expect([...island.el.querySelectorAll("[role=tab]")].map((t) => t.id)).toEqual([
      "tab-media",
      "tab-clock",
      "tab-timer",
      "tab-volume",
      "tab-clipboard",
      "tab-stats",
      "tab-privacy",
      "tab-dictation",
      "tab-tts",
    ]);
    await island.leave();
    expect(island.el.dataset.open).toBe("false");
    expect(island.size()).toEqual({ width: "200px", height: "32px" });
    expect(sys.recorded.regions.at(-1)).toEqual({ width: 220, height: 32 });
  });

  it("doesn't open when the pointer only passes by", async () => {
    environment();
    const island = await startIsland(system());
    island.el.dispatchEvent(new PointerEvent("pointerenter"));
    await advance(50);
    island.el.dispatchEvent(new PointerEvent("pointerleave"));
    await advance(1000);
    expect(island.el.dataset.open).toBe("false");
  });
});

describe("a timer, from start to end", () => {
  it("counts down on the pill once started, then asks for attention and opens on its tab", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    await island.hover();
    island.el.querySelector<HTMLElement>("#tab-timer")?.click();
    const panel = island.el.querySelector<HTMLElement>("#panel-timer")!;
    [...panel.querySelectorAll<HTMLButtonElement>(".chip")].find((b) => b.textContent === "1m")?.click();
    panel.querySelector<HTMLButtonElement>(".primary")?.click();
    // Another tab is open when the timer ends.
    island.el.querySelector<HTMLElement>("#tab-clock")?.click();
    await island.leave();
    await advance(1000);
    expect(island.glances()[1]).toMatch(/^0:5\d$/);
    await advance(60_000);
    expect(island.glances()[1]).toBe("Done");
    expect(island.el.dataset.alert).toBe("true");
    await island.hover();
    expect(island.el.querySelector("#tab-timer")?.getAttribute("aria-selected")).toBe("true");
  });
});

describe("dictation", () => {
  it("shows the recording on the pill while listening, then what happened to the text", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    sys.push.phase({ phase: "listening", level: 0.5, seconds: 3 });
    await advance(1000);
    expect([island.glances()[1], island.marks()[1], island.el.dataset.wide]).toEqual(["0:03", "rec", "true"]);
    sys.push.phase({ phase: "done", text: "hello", delivery: "typed" });
    await advance(1000);
    expect(island.glances()[1]).toBe("Typed");
    await advance(5000);
    expect(island.glances()[1]).toBe("42%");
  });
});

describe("read aloud", () => {
  it("shows on the pill while reading, then reads the text again from its tab", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    sys.push.reading({ phase: "speaking", text: "Hello there" });
    await advance(1000);
    expect([island.glances()[1], island.marks()[1], island.el.dataset.wide]).toEqual(["Reading aloud", "eq", "true"]);
    sys.push.reading({ phase: "idle" });
    await advance(1000);
    expect(island.glances()[1]).toBe("42%");
    await island.hover();
    island.el.querySelector<HTMLElement>("#tab-tts")?.click();
    island.el.querySelector<HTMLButtonElement>("#panel-tts .dict-main")?.click();
    expect(sys.recorded.spoken).toEqual(["Hello there"]);
  });
});
