import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { bindings, commandsOf, fromKey, keycaps, shortcutOf } = await import("./commands");
const { matching } = await import("../features/clipboard/picker");
const { defaults, parseSettings } = await import("./settings");

const command = (id: string, shortcut: string | null) => ({ id, label: id, description: "", shortcut, popup: () => ({ show() {} }) });
const plugin = (id: string, commands: ReturnType<typeof command>[]) => ({ id, label: id, description: "", icon: "", slots: [], commands, setup: () => ({}) });
const catalogue = [plugin("clipboard", [command("history", "Super+Shift+KeyB")]), plugin("timer", [command("start", null)]), plugin("clock", [])];

describe("commands", () => {
  it("lists every command with its full id", () => expect(commandsOf(catalogue).map((e) => e.id)).toEqual(["clipboard.history", "timer.start"]));

  it("uses the default unless the user chose, and null turns a shortcut off", () => {
    const [history] = commandsOf(catalogue);
    if (!history) throw new Error("missing command");
    expect(shortcutOf(history, {})).toBe("Super+Shift+KeyB");
    expect(shortcutOf(history, { "clipboard.history": "Ctrl+Alt+KeyV" })).toBe("Ctrl+Alt+KeyV");
    expect(shortcutOf(history, { "clipboard.history": null })).toBeNull();
  });

  it("binds only commands that have a shortcut", () => {
    expect(bindings(catalogue, {})).toEqual({ "clipboard.history": { shortcut: "Super+Shift+KeyB", surface: "popup" } });
    expect(bindings(catalogue, { "timer.start": "Alt+KeyT", "clipboard.history": null })).toEqual({
      "timer.start": { shortcut: "Alt+KeyT", surface: "popup" },
    });
  });
});

describe("recording a shortcut", () => {
  const key = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    code,
    ...mods,
  });

  it("builds modifiers in a stable order with the physical key", () =>
    expect(fromKey(key("KeyB", { shiftKey: true, metaKey: true, ctrlKey: true }))).toBe("Ctrl+Shift+Super+KeyB"));

  it("puts Alt after Ctrl and before Shift", () =>
    expect(fromKey(key("KeyV", { shiftKey: true, altKey: true, ctrlKey: true }))).toBe("Ctrl+Alt+Shift+KeyV"));

  it("waits while only modifiers are held", () => expect(fromKey(key("ShiftLeft", { shiftKey: true }))).toBeNull());

  it("needs a modifier, except for function keys", () => {
    expect(fromKey(key("KeyB"))).toBeNull();
    expect(fromKey(key("F9"))).toBe("F9");
  });

  it("shows shortcuts as readable keycaps", () => {
    expect(keycaps("Super+Shift+KeyB")).toEqual(["Win", "Shift", "B"]);
    expect(keycaps("Ctrl+Alt+Digit1")).toEqual(["Ctrl", "Alt", "1"]);
  });
});

describe("clipboard picker search", () => {
  const clips = [
    { id: 1, text: "https://tauri.app/start", image: null, copiedAt: 3 },
    { id: 2, text: "Meeting notes for Friday", image: null, copiedAt: 2 },
    { id: 3, text: "#0A84FF", image: null, copiedAt: 1 },
  ];

  it("keeps history order and matches every word, ignoring case", () => {
    expect(matching(clips, "")).toEqual(clips);
    expect(matching(clips, "friday MEETING").map((c) => c.copiedAt)).toEqual([2]);
    expect(matching(clips, "nothing like this")).toEqual([]);
  });
});

describe("shortcut settings", () => {
  const fallback = defaults({ glance: { left: [], right: [] }, tabs: [] });

  it("keeps chosen and turned-off shortcuts, drops invalid ones", () => {
    expect(parseSettings({ shortcuts: { "clipboard.history": "Alt+KeyV", "timer.start": null } }, fallback).shortcuts).toEqual({
      "clipboard.history": "Alt+KeyV",
      "timer.start": null,
    });
    expect(parseSettings({ shortcuts: { "clipboard.history": 5 } }, fallback).shortcuts).toEqual({});
  });
});

describe("screenshot", async () => {
  const { chosenArea, fileName, fitSize, rectFrom, shapeEnd } = await import("../features/screenshot/editor");

  it("a drag picks an area; a click (tiny area) means the whole screen", () => {
    expect(chosenArea({ x: 10, y: 10, w: 200, h: 120 })).toEqual({ x: 10, y: 10, w: 200, h: 120 });
    expect(chosenArea({ x: 10, y: 10, w: 3, h: 2 })).toBeNull();
    expect(chosenArea(null)).toBeNull();
  });

  it("shows the crop at its real size, shrinking only when it doesn't fit", () => {
    expect(fitSize(800, 400, 1, { w: 1800, h: 900 })).toEqual({ w: 800, h: 400 });
    expect(fitSize(1600, 800, 2, { w: 1800, h: 900 })).toEqual({ w: 800, h: 400 });
    expect(fitSize(1920, 1080, 1, { w: 960, h: 900 })).toEqual({ w: 960, h: 540 });
  });

  it("leaves a shape's corner alone without Shift", () => expect(shapeEnd([10, 10], [50, 30], false)).toEqual([50, 30]));

  it("makes squares and circles with Shift, in any drag direction", () => {
    expect(shapeEnd([10, 10], [50, 30], true)).toEqual([50, 50]);
    expect(shapeEnd([100, 100], [80, 40], true)).toEqual([40, 40]);
    expect(shapeEnd([10, 10], [10, 25], true)).toEqual([25, 25]);
  });
  const { decode } = await import("../features/screenshot/service");

  it("builds an area from corners in any order, clamped to the image", () => {
    expect(rectFrom([50, 40], [10, 10], 100, 100)).toEqual({ x: 10, y: 10, w: 40, h: 30 });
    expect(rectFrom([-20, 90], [130, 120], 100, 100)).toEqual({ x: 0, y: 90, w: 100, h: 10 });
  });

  it("names saved files in local time", () => expect(fileName(new Date(2026, 9, 14, 23, 5, 7))).toBe("Screenshot 2026-10-14 at 23.05.07.png"));

  it("decodes a capture and rejects inconsistent buffers", () => {
    const buf = new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    const image = decode(buf);
    expect([image?.width, image?.height, image?.rgba.length]).toEqual([2, 1, 8]);
    expect(decode(new ArrayBuffer(0))).toBeNull();
    expect(decode(new Uint8Array([9, 0, 0, 0, 9, 0, 0, 0, 1]).buffer)).toBeNull();
  });
});
