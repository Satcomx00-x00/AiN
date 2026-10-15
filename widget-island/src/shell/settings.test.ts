import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { choice, folder, list, number, resolve, toggle } = await import("../sdk/options");
const { DEFAULT_GENERAL, defaults, memorySettings, parseSettings } = await import("./settings");
const { move } = await import("./windows/settings/slots");

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

  it("keeps the pill's shape within range", () => {
    expect(parseSettings({ general: { pillWidth: 320, pillCurve: 40 } }, fallback).general).toMatchObject({ pillWidth: 320, pillCurve: 40 });
    expect(parseSettings({ general: { pillWidth: 5000, pillCurve: -1 } }, fallback).general).toEqual(DEFAULT_GENERAL);
  });

  it("keeps valid colors, lowercased", () => {
    expect(parseSettings({ general: { pillColor: "#1C1C1E", accentColor: "red" } }, fallback).general).toMatchObject({
      pillColor: "#1c1c1e",
      accentColor: DEFAULT_GENERAL.accentColor,
    });
  });

  it("keeps the startup animation's id, or the default for anything that can't be one", () => {
    expect(DEFAULT_GENERAL.greeting).toBe("hello");
    expect(parseSettings({ general: { greeting: "my-wave" } }, fallback).general.greeting).toBe("my-wave");
    expect(parseSettings({ general: { greeting: "none" } }, fallback).general.greeting).toBe("none");
    for (const bad of ["", "Wave", "x", 3, "a".repeat(33)]) expect(parseSettings({ general: { greeting: bad } }, fallback).general.greeting).toBe("hello");
    expect(parseSettings({ general: {} }, fallback).general.greeting).toBe("hello");
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

describe("folder option", () => {
  it("keeps a trimmed path, or the default location", () => {
    const fields = { dir: folder("Model folder") };
    expect(resolve(fields, { dir: "  D:\\Models " })).toEqual({ dir: "D:\\Models" });
    expect(resolve(fields, { dir: 3 })).toEqual({ dir: "" });
  });
});

describe("pill color", () => {
  it("picks dark text only for light colors", async () => {
    const { isLight } = await import("../sdk/color");
    expect(isLight("#000000")).toBe(false);
    expect(isLight("#0b1a33")).toBe(false);
    expect(isLight("#f2f2f7")).toBe(true);
    expect(isLight("#ffd60a")).toBe(true);
  });
});

describe("themes and the color picker", () => {
  it("converts colors to the picker's terms and back", async () => {
    const { hexToHsv, hsvToHex, parseHex } = await import("../sdk/color");
    for (const c of ["#000000", "#ffffff", "#0a84ff", "#ff375f", "#7aa2f7", "#272822"]) expect(hsvToHex(hexToHsv(c))).toBe(c);
    expect(hexToHsv("#ff0000")).toEqual([0, 1, 1]);
    expect(parseHex(" 0A84FF ")).toBe("#0a84ff");
    expect(parseHex("#08f")).toBe("#0088ff");
    expect(parseHex("blue")).toBeNull();
  });

  it("lists valid, distinct themes", async () => {
    const { THEMES, themeById } = await import("./themes");
    const { isHex } = await import("../sdk/color");
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    for (const t of THEMES) for (const c of [t.bg, t.fg, t.accent, t.ok, t.warn, t.hot, t.done]) expect(isHex(c), `${t.id} ${c}`).toBe(true);
    expect(themeById("tokyo-night").name).toBe("Tokyo Night");
    expect(themeById("gone").id).toBe("island");
  });

  it("keeps the theme's text color only where it stays readable", async () => {
    const { palette, themeById } = await import("./themes");
    const monokai = themeById("monokai");
    expect(palette(monokai, "#1e1e1e", "#66d9ef")["--fg"]).toBe(monokai.fg);
    expect(palette(monokai, "#f2f2f7", "#66d9ef")["--fg"]).toBe("#1c1c1e");
    expect(palette(monokai, "#272822", "#ffcc66")["--on-accent"]).toBe("#1c1c1e");
  });
});

describe("plugins from the plugins folder", async () => {
  const { placeNew, runnable, setExtension, without } = await import("./settings");

  it("reads which files are on, keeping each name once and dropping anything else", () => {
    expect(parseSettings({ extensions: ["a.js", "a.js", "w/index.js"] }, fallback).extensions).toEqual(["a.js", "w/index.js"]);
    expect(parseSettings({ extensions: "a.js" }, fallback).extensions).toEqual([]);
    expect(parseSettings({ extensions: ["a.js", 3] }, fallback).extensions).toEqual([]);
    expect(parseSettings({}, fallback).extensions).toEqual([]);
  });

  it("turns a file on once, however often asked", () => {
    const on = setExtension(setExtension(fallback, "a.js", true), "a.js", true);
    expect(on.extensions).toEqual(["a.js"]);
    expect(on.layout).toBe(fallback.layout);
  });

  it("turning a file off also takes its plugin out of every spot", () => {
    const placed = { ...fallback, extensions: ["a.js", "b.js"], layout: { glance: { left: ["pomo"], right: ["media", "pomo"] }, tabs: ["pomo", "clock"] } };
    const off = setExtension(placed, "a.js", false, { id: "pomo", slots: ["tab"] });
    expect(off.extensions).toEqual(["b.js"]);
    expect(off.layout).toEqual({ glance: { left: [], right: ["media"] }, tabs: ["clock"] });
  });

  it("turning off a file whose plugin never loaded leaves the layout alone", () =>
    expect(setExtension({ ...fallback, extensions: ["a.js"] }, "a.js", false)).toEqual({ ...fallback, extensions: [] }));

  it("places a new plugin as a tab when it can be one, else on the right of the pill", () => {
    expect(placeNew(fallback, { id: "pomo", slots: ["glance", "tab"] }).layout.tabs).toEqual([...layout.tabs, "pomo"]);
    const glanceOnly = placeNew(fallback, { id: "pomo", slots: ["glance"] }).layout;
    expect(glanceOnly.glance.right).toEqual([...layout.glance.right, "pomo"]);
    expect(glanceOnly.tabs).toEqual(layout.tabs);
  });

  it("leaves a plugin the user already placed where it is", () => {
    const settings = { ...fallback, layout: { ...layout, glance: { ...layout.glance, left: ["pomo"] } } };
    expect(placeNew(settings, { id: "pomo", slots: ["tab"] })).toBe(settings);
  });

  it("runs only plugins whose file is still on, whatever the stored layout says", () => {
    const settings = { ...fallback, extensions: ["on.js"], layout: { glance: { left: ["clock"], right: ["off", "on"] }, tabs: ["off", "on", "media"] } };
    const loaded = [
      { file: "on.js", id: "on" },
      { file: "off.js", id: "off" },
    ];
    expect(runnable(settings, loaded)).toEqual({ glance: { left: ["clock"], right: ["on"] }, tabs: ["on", "media"] });
  });

  it("removes ids from a layout without touching the others", () =>
    expect(without(layout, new Set(["media"]))).toEqual({ glance: { left: ["clock"], right: ["stats"] }, tabs: ["clock"] }));
});

describe("settings targets", async () => {
  const { parseTarget } = await import("./settings");
  const sections = ["general", "widgets"];

  it("reads a section, then a card", () => {
    expect(parseTarget("widgets:dictation", sections)).toEqual({ section: "widgets", card: "dictation" });
    expect(parseTarget("general", sections)).toEqual({ section: "general", card: null });
  });

  it("ignores places that don't exist", () => {
    expect(parseTarget("", sections)).toBeNull();
    expect(parseTarget("secret:x", sections)).toBeNull();
  });
});

describe("text options", async () => {
  const { text, resolve: resolveOptions } = await import("../sdk/options");
  it("keep a trimmed string, or the default", () => {
    const fields = { mic: text("Microphone") };
    expect(resolveOptions(fields, { mic: "  wasapi:{a} " })).toEqual({ mic: "wasapi:{a}" });
    expect(resolveOptions(fields, { mic: 3 })).toEqual({ mic: "" });
  });
});
