// @vitest-environment happy-dom
/**
 * Settings reach the running island live, as they do when saved from the settings window:
 * the pill's style, size, colors and hiding, plus plugin files from the plugins folder.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACK, advance, environment, restore, startIsland, system } from "./harness";

afterEach(restore);

describe("the pill's size", () => {
  it("grows and shrinks live, the input region growing first and shrinking last", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    await advance(1000);
    await sys.save((s) => ({ ...s, general: { ...s.general, pillSize: "large" } }));
    await advance(0);
    expect(island.size()).toEqual({ width: "520px", height: "44px" });
    expect(island.el.style.getPropertyValue("--scale")).toBe("1.375");
    expect(sys.recorded.regions.at(-1)).toEqual({ width: 520 + 2 * 14, height: 44 });
    await sys.save((s) => ({ ...s, general: { ...s.general, pillSize: "low" } }));
    await advance(0);
    expect(island.size()).toEqual({ width: "320px", height: "20px" });
    expect(sys.recorded.regions.at(-1)).toEqual({ width: 320 + 2 * 7, height: 20 });
  });

  it("opens below the pill at every size, never narrower than the pill", async () => {
    environment();
    const sys = system();
    await sys.save((s) => ({ ...s, general: { ...s.general, pillSize: "large" } }));
    const island = await startIsland(sys);
    await island.hover();
    expect(island.size()).toEqual({ width: "520px", height: `${44 + 156}px` });
  });

  it("keeps a hardware notch's size, with room for glances beside it", async () => {
    environment();
    const sys = system();
    sys.hardware({ width: 185, height: 32, hasNotch: true });
    await sys.save((s) => ({ ...s, general: { ...s.general, pillSize: "low" } }));
    const island = await startIsland(sys);
    expect(island.size()).toEqual({ width: `${185 + 2 * 64}px`, height: "32px" });
  });
});

describe("the pill's style", () => {
  it("switches live between the built-in styles, each with its own look and size", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    sys.push.track(TRACK);
    await advance(1000);
    const pick = async (style: string) => {
      await sys.save((s) => ({ ...s, general: { ...s.general, style } }));
      await advance(1000);
      return { style: island.el.dataset.style, size: island.size(), glances: island.glances(), marks: island.marks() };
    };
    expect(await pick("solo")).toEqual({ style: "solo", size: { width: "376px", height: "32px" }, glances: ["Midnight City"], marks: ["eq"] });
    expect(await pick("stub")).toEqual({ style: "stub", size: { width: "56px", height: "14px" }, glances: [""], marks: ["eq"] });
    const sliver = await pick("sliver");
    expect([sliver.style, sliver.size, sliver.glances]).toEqual(["sliver", { width: "280px", height: "6px" }, []]);
    expect(island.el.querySelector<HTMLElement>(".glance.sliver")?.dataset.playing).toBe("true");
    expect(await pick("pill")).toEqual({ style: "pill", size: { width: "496px", height: "32px" }, glances: ["09:41", "Midnight City"], marks: ["", "eq"] });
  });

  it("each style comes in every size", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    const sizes: Record<string, [string, string][]> = {
      pill: [["320px", "20px"], ["400px", "32px"], ["520px", "44px"]],
      solo: [["224px", "20px"], ["280px", "32px"], ["364px", "44px"]],
      stub: [["35px", "9px"], ["56px", "14px"], ["77px", "19px"]],
      sliver: [["224px", "4px"], ["280px", "6px"], ["364px", "8px"]],
      hidden: [["320px", "20px"], ["400px", "32px"], ["520px", "44px"]],
    };
    for (const [style, expected] of Object.entries(sizes))
      for (const [n, pillSize] of (["low", "normal", "large"] as const).entries()) {
        await sys.save((s) => ({ ...s, general: { ...s.general, style, pillSize } }));
        await advance(0);
        expect([style, pillSize, island.size()]).toEqual([style, pillSize, { width: expected[n]![0], height: expected[n]![1] }]);
      }
  });

  it("hides the pill with the Hidden style until the cursor rests on its spot", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    await sys.save((s) => ({ ...s, general: { ...s.general, style: "hidden", revealDelay: 800 } }));
    await advance(0);
    expect(sys.recorded.rules.at(-1)).toEqual([800, 760]);
    sys.reveal(false);
    expect(island.el.dataset.hidden).toBe("true");
    sys.reveal(true);
    expect(island.el.dataset.hidden).toBe("false");
    await sys.save((s) => ({ ...s, general: { ...s.general, style: "pill" } }));
    await advance(0);
    expect(sys.recorded.rules.at(-1)).toEqual([null, 760]);
  });

  it("reads settings saved before styles existed: the old “Hide the pill” switch is the Hidden style", async () => {
    environment();
    const sys = system();
    await sys.store.save({ version: 1, general: { autoHide: true, revealDelay: 600 } } as never);
    const island = await startIsland(sys);
    await advance(0);
    expect(island.el.dataset.style).toBe("hidden");
    expect(sys.recorded.rules.at(-1)).toEqual([600, 760]);
  });
});

describe("colors", () => {
  it("paints the pill with the chosen colors", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    await sys.save((s) => ({ ...s, general: { ...s.general, pillColor: "#f5f5f7", accentColor: "#ff375f" } }));
    await advance(0);
    expect([island.el.style.getPropertyValue("--bg"), island.el.style.getPropertyValue("--accent"), island.el.dataset.tone]).toEqual([
      "#f5f5f7",
      "#ff375f",
      "light",
    ]);
  });
});

describe("plugin files", () => {
  const widget = (island: { definePlugin: (d: unknown) => unknown }) =>
    island.definePlugin({
      id: "weather",
      label: "Weather",
      description: "",
      icon: "",
      slots: ["glance"],
      setup: () => ({ glance: () => ({ text: "18°" }) }),
    });

  it("runs nothing from the folder until a file is turned on", async () => {
    environment();
    const sys = system();
    const def = vi.fn(widget);
    sys.addFile("weather.js", def as never);
    await startIsland(sys);
    expect(def).not.toHaveBeenCalled();
  });

  it("shows a plugin's widget on the pill once its file is on and it is placed", async () => {
    environment();
    const sys = system();
    sys.addFile("weather.js", widget as never);
    const island = await startIsland(sys);
    await sys.save((s) => ({ ...s, extensions: ["weather.js"], layout: { ...s.layout, glance: { left: ["weather"], right: s.layout.glance.right } } }));
    await advance(1000);
    expect(island.glances()[0]).toBe("18°");
    // Turned off, it leaves the pill at once.
    await sys.save((s) => ({ ...s, extensions: [] }));
    await advance(1000);
    expect(island.glances()[0]).toBe("");
  });

  it("draws the island with a plugin's style once picked, at the chosen size", async () => {
    environment();
    const sys = system();
    sys.addFile("neon.js", (island) =>
      island.defineStyle({
        id: "neon",
        label: "Neon",
        widens: false,
        size: (pill) => ({ width: pill.width, height: Math.round(4 * pill.scale) }),
        mount: (root) => {
          const line = document.createElement("i");
          line.className = "neon";
          root.append(line);
          return { draw: (f) => void (line.dataset.alert = String(f.alert)) };
        },
      }),
    );
    const island = await startIsland(sys);
    await sys.save((s) => ({ ...s, extensions: ["neon.js"], general: { ...s.general, style: "neon", pillSize: "large" } }));
    await advance(1000);
    expect(island.el.dataset.style).toBe("neon");
    expect(island.size()).toEqual({ width: "520px", height: "6px" });
    expect(island.el.querySelector<HTMLElement>(".glance .neon")?.dataset.alert).toBe("false");
  });

  it("falls back to the Pill when a plugin's style breaks, and says why", async () => {
    environment();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sys = system();
    sys.addFile("broken.js", (island) =>
      island.defineStyle({
        id: "broken",
        label: "Broken",
        mount: () => ({
          draw() {
            throw new Error("boom");
          },
        }),
      }),
    );
    const island = await startIsland(sys);
    await sys.save((s) => ({ ...s, extensions: ["broken.js"], general: { ...s.general, style: "broken" } }));
    await advance(2000);
    expect(island.el.dataset.style).toBe("pill");
    expect(island.glances()).toEqual(["09:41", "42%"]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`pill style "broken": draw failed`));
  });

  it("plays a plugin's startup animation when it is picked, and again on Play", async () => {
    environment();
    const sys = system();
    const play = vi.fn();
    sys.addFile("wave.js", (island) => island.defineGreeting({ id: "wave", label: "Wave", play }));
    await startIsland(sys);
    await advance(1000);
    // As in Settings: the file is turned on first, then its animation picked.
    await sys.save((s) => ({ ...s, extensions: ["wave.js"], general: { ...s.general, pillSize: "low" } }));
    await advance(1000);
    await sys.save((s) => ({ ...s, general: { ...s.general, greeting: "wave" } }));
    await advance(1000);
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0]![0]).toMatchObject({ size: { width: 320, height: 20 }, scale: 0.625 });
    await sys.store.playGreeting("wave");
    await advance(1000);
    expect(play).toHaveBeenCalledTimes(2);
  });
});
