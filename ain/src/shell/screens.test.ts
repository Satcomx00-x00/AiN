import { describe, expect, it, vi } from "vitest";

const island = vi.hoisted(() => ({ listen: vi.fn(), screens: vi.fn() }));
vi.mock("./bindings/island", () => ({ commands: { screens: island.screens }, events: { screensChanged: { listen: island.listen } } }));

const { PRIMARY, fixedScreens, screenOptions, screenSetting, tauriScreens } = await import("./screens");
type Screen = import("./screens").Screen;

const screen = (id: string, primary: boolean, scale = 1): Screen => ({ id, name: id, width: 2560, height: 1440, x: 0, y: 0, scale, primary });
const laptop = screen("Built-in", true, 2);
const external = screen("DELL U2720Q", false);

describe("the screen picker", () => {
  it("offers the primary first, then each screen with its resolution", () => {
    expect(screenOptions([laptop, external], null)).toEqual([
      { value: PRIMARY, label: "Primary screen", detail: "Now Built-in" },
      { value: "Built-in", label: "Built-in", detail: "2560 × 1440 · 200%", badge: "Primary" },
      { value: "DELL U2720Q", label: "DELL U2720Q", detail: "2560 × 1440", badge: undefined },
    ]);
  });

  it("keeps an unplugged choice listed, saying where the pill is meanwhile", () => {
    const options = screenOptions([laptop], "DELL U2720Q");
    expect(options.at(-1)).toMatchObject({ value: "DELL U2720Q", badge: "Unplugged" });
    expect(screenOptions([laptop, external], "DELL U2720Q")).toHaveLength(3);
  });

  it("works with no screen known or none primary", () => {
    expect(screenOptions([], null)).toEqual([{ value: PRIMARY, label: "Primary screen", detail: "The system's main screen" }]);
    expect(screenOptions([external], null)[0]?.detail).toBe("The system's main screen");
  });

  it("saves the primary as null", () => {
    expect(screenSetting(PRIMARY)).toBeNull();
    expect(screenSetting("DELL U2720Q")).toBe("DELL U2720Q");
  });

  it("lists a fixed set once", async () => {
    const seen: (readonly Screen[])[] = [];
    const stop = await fixedScreens([laptop]).watch((s) => seen.push(s));
    stop();
    expect(seen).toEqual([[laptop]]);
  });

  it("follows the backend's screens: now, then on each change", async () => {
    let push: (e: { payload: Screen[] }) => void = () => {};
    island.listen.mockImplementation(async (cb: typeof push) => ((push = cb), () => {}));
    island.screens.mockResolvedValue([laptop]);
    const seen: (readonly Screen[])[] = [];
    await tauriScreens.watch((s) => seen.push(s));
    push({ payload: [laptop, external] });
    expect(seen).toEqual([[laptop], [laptop, external]]);
  });
});
