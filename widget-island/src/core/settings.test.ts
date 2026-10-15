import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { choice, list, number, resolve, toggle } = await import("./options");
const { DEFAULT_GENERAL, defaults, memorySettings, parseSettings } = await import("./settings");
const { move } = await import("../settings/slots");

const layout = { glance: { left: ["clock"], right: ["media", "stats"] }, tabs: ["media", "clock"] };
const fallback = defaults(layout);

describe("plugin options", () => {
  const fields = {
    on: toggle("On", true),
    delay: number("Delay", 5, { min: 1, max: 10 }),
    mode: choice("Mode", "a", [
      ["a", "A"],
      ["b", "B"],
    ]),
    names: list("Names", ["x"]),
  };

  it("uses defaults when nothing is stored", () => expect(resolve(fields, undefined)).toEqual({ on: true, delay: 5, mode: "a", names: ["x"] }));

  it("keeps valid stored values", () =>
    expect(resolve(fields, { on: false, delay: 7, mode: "b", names: ["y"] })).toEqual({ on: false, delay: 7, mode: "b", names: ["y"] }));

  it("replaces wrong types and unknown choices, clamps numbers", () =>
    expect(resolve(fields, { on: "yes", delay: 99, mode: "z", names: "y" })).toEqual({ on: true, delay: 10, mode: "a", names: ["x"] }));

  it("cleans lists: trims, drops blanks, non-strings and duplicates", () =>
    expect(resolve(fields, { names: [" a ", "", "a", 3, "b"] }).names).toEqual(["a", "b"]));
});

describe("settings", () => {
  it("falls back entirely for a missing or corrupt file", () => {
    expect(parseSettings(null, fallback)).toEqual(fallback);
    expect(parseSettings("garbage", fallback)).toEqual(fallback);
  });

  it("keeps valid parts of a partial file", () => {
    const s = parseSettings({ general: { openDelay: 300 }, options: { privacy: { ignore: ["Sonar"] } } }, fallback);
    expect(s.general).toEqual({ ...DEFAULT_GENERAL, openDelay: 300 });
    expect(s.layout).toEqual(layout);
    expect(s.options.privacy).toEqual({ ignore: ["Sonar"] });
  });

  it("rejects out-of-range delays and broken layouts", () => {
    const s = parseSettings({ general: { openDelay: -5, closeDelay: 99_999 }, layout: { tabs: "clock" } }, fallback);
    expect(s.general).toEqual(DEFAULT_GENERAL);
    expect(s.layout).toEqual(layout);
  });

  it("removes duplicate ids in a placement", () =>
    expect(parseSettings({ layout: { glance: { left: ["clock", "clock"], right: [] }, tabs: [] } }, fallback).layout.glance.left).toEqual(["clock"]));

  it("the in-memory store echoes saves to watchers", async () => {
    const store = memorySettings();
    const seen: unknown[] = [];
    await store.watch((raw) => seen.push(raw));
    await store.save(fallback);
    expect(seen).toEqual([null, fallback]);
  });
});

describe("reordering", () => {
  it("moves an item and clamps the target", () => {
    expect(move(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(move(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(move(["a", "b"], 1, 9)).toEqual(["a", "b"]);
    expect(move(["a", "b"], 0, -3)).toEqual(["a", "b"]);
  });
});

describe("new plugins", async () => {
  const { adopt } = await import("./settings");
  const fallback = { glance: { left: ["clock"], right: ["dictation", "volume", "stats"] }, tabs: ["clock", "stats", "dictation"] };

  it("adds a plugin the saved layout has never seen, where the default puts it", () => {
    const mine = { glance: { left: ["clock"], right: ["stats", "volume"] }, tabs: ["stats", "clock"] };
    expect(adopt(mine, fallback, ["clock", "volume", "stats"])).toEqual({
      glance: { left: ["clock"], right: ["dictation", "stats", "volume"] },
      tabs: ["stats", "clock", "dictation"],
    });
  });

  it("keeps a plugin out once the user removed it", () => {
    const mine = { glance: { left: [], right: ["stats"] }, tabs: ["stats"] };
    expect(adopt(mine, fallback, ["clock", "volume", "stats", "dictation"])).toBe(mine);
  });

  it("adopts once: the parsed settings remember what they have seen", () => {
    const stored = { version: 1, layout: { glance: { left: [], right: ["stats"] }, tabs: ["stats"] } };
    const once = parseSettings(stored, defaults(fallback));
    expect(once.layout.tabs).toEqual(["stats", "dictation"]);
    const removed = { ...once, layout: { ...once.layout, tabs: ["stats"] } };
    expect(parseSettings(removed, defaults(fallback)).layout.tabs).toEqual(["stats"]);
  });
});
