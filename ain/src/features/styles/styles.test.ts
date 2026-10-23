// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Folded, PillSize } from "../../sdk/style";

const { styles } = await import(".");
const { pillOf } = await import("../../shell/geometry");
const { lead, privacy, progressOf } = await import("./lead");
const { markOf } = await import("./stub");

afterEach(() => vi.restoreAllMocks());

const quiet: Folded = { left: null, right: null, ambient: null, alert: false, wide: false, now: 0 };
const byId = (id: string) => styles.find((s) => s.id === id)!;
const island = { width: 200, height: 32, hasNotch: false };
const notch = { width: 185, height: 32, hasNotch: true };

/** Mounts a style on a fresh glance row, as the island does. */
function mounted(id: string) {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  const root = document.createElement("div");
  root.className = "glance";
  const view = byId(id).mount(root, { options: () => ({}) });
  return { root, view };
}

const texts = (root: HTMLElement) => [...root.querySelectorAll(".g-text")].map((t) => t.textContent);

describe("the built-in pill styles", () => {
  it("have distinct, valid ids, labels and descriptions, the Pill first (the default)", () => {
    expect(styles.map((s) => s.id)).toEqual(["pill", "solo", "stub", "sliver", "hidden"]);
    for (const s of styles) {
      expect(s.id).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(s.label.trim()).not.toBe("");
      expect(s.description?.trim()).not.toBe("");
    }
  });

  it.each([
    // style, low profile, normal, large
    ["pill", [160, 20], [200, 32], [260, 44]],
    ["hidden", [160, 20], [200, 32], [260, 44]],
    ["solo", [112, 20], [140, 32], [182, 44]],
    ["stub", [35, 9], [56, 14], [77, 19]],
    ["sliver", [112, 4], [140, 6], [182, 8]],
  ] as const)("%s comes in every pill size", (id, low, normal, large) => {
    const sizes: [PillSize, readonly [number, number]][] = [["low", low], ["normal", normal], ["large", large]];
    for (const [size, [width, height]] of sizes) {
      const pill = pillOf(island, size);
      expect(byId(id).size?.(pill, {}) ?? { width: pill.width, height: pill.height }).toEqual({ width, height });
    }
  });

  it("stay a pill beside a hardware notch, where a strip or a tab wouldn't show", () => {
    const pill = pillOf(notch, "low");
    for (const s of styles) expect(s.size?.(pill, {}) ?? pill).toMatchObject({ width: pill.width, height: pill.height });
  });

  it("widen for a live activity only when they show text", () => {
    expect(styles.filter((s) => s.widens === false).map((s) => s.id)).toEqual(["stub", "sliver"]);
  });
});

describe("the Pill", () => {
  it("shows one glance at each end, from the plugins speaking there", () => {
    const { root, view } = mounted("pill");
    view.draw({ ...quiet, left: { text: "00:41" }, right: { text: "62%", progress: 0.62 }, leftFrom: "clock", rightFrom: "stats" });
    expect(root.children).toHaveLength(2);
    expect(texts(root)).toEqual(["00:41", "62%"]);
  });

  it("is the same look as Hidden, which only stays out of sight", () => {
    expect([byId("pill").hidden, byId("hidden").hidden]).toEqual([undefined, true]);
    expect(byId("hidden").mount).toBe(byId("pill").mount);
  });
});

describe("Solo", () => {
  it("shows the one glance that matters most, centered", () => {
    const { root, view } = mounted("solo");
    expect(root.classList.contains("solo")).toBe(true);
    view.draw({ ...quiet, left: { text: "00:41" }, right: { text: "62%" } });
    expect(texts(root)).toEqual(["62%"]);
    view.draw({ ...quiet, left: { text: "Done", tone: "alert" }, right: { text: "62%" } });
    expect(texts(root)).toEqual(["Done"]);
    view.draw(quiet);
    expect(texts(root)).toEqual([""]);
  });
});

describe("Stub", () => {
  it("brings each glance down to one mark, or none for plain text", () => {
    expect(markOf({ text: "00:41" })).toBeNull();
    expect(markOf({ text: "Song", mark: "eq", art: "a.png" })).toEqual({ text: "", mark: "eq" });
    expect(markOf({ text: "04:12", progress: 0.7 })).toEqual({ text: "", progress: 0.7 });
    expect(markOf({ text: "64", level: 0.64 })).toEqual({ text: "", progress: 0.64 });
    expect(markOf({ text: "Discord", mark: "mic" })).toEqual({ text: "", mark: "mic" });
    expect(markOf({ text: "Done", tone: "alert" })).toEqual({ text: "", mark: "rec", tone: "alert" });
  });

  it("shows the mic or camera over anything else, and no text", () => {
    const { root, view } = mounted("stub");
    view.draw({ ...quiet, left: { text: "Discord", mark: "mic" }, right: { text: "Song", mark: "eq", wide: true } });
    expect(root.querySelector<HTMLElement>(".mark")?.dataset.kind).toBe("mic");
    expect(texts(root)).toEqual([""]);
    view.draw({ ...quiet, right: { text: "Song", mark: "eq", wide: true } });
    expect(root.querySelector<HTMLElement>(".mark")?.dataset.kind).toBe("eq");
  });
});

describe("Sliver", () => {
  it("draws progress as a line, and hides it without any", () => {
    const { root, view } = mounted("sliver");
    const line = root.querySelector<HTMLElement>(".sliver-line")!;
    view.draw({ ...quiet, left: { text: "00:41" } });
    expect(line.hidden).toBe(true);
    view.draw({ ...quiet, right: { text: "04:12", progress: 0.7 } });
    expect([line.hidden, line.querySelector("i")?.style.getPropertyValue("--p"), root.dataset.playing]).toEqual([false, "0.7", "false"]);
  });

  it("fills the line while music plays without progress", () => {
    const { root, view } = mounted("sliver");
    const line = root.querySelector<HTMLElement>(".sliver-line")!;
    view.draw({ ...quiet, right: { text: "Song", mark: "eq", wide: true } });
    expect([line.hidden, line.querySelector("i")?.style.getPropertyValue("--p"), root.dataset.playing]).toEqual([false, "1", "true"]);
  });

  it("turns orange on an alert, and shows the mic and camera as dots", () => {
    const { root, view } = mounted("sliver");
    const dot = (kind: string) => root.querySelector<HTMLElement>(`.sliver-dot[data-kind="${kind}"]`)!;
    view.draw({ ...quiet, alert: true, left: { text: "Discord", mark: "mic" } });
    expect([root.dataset.alert, dot("mic").hidden, dot("camera").hidden]).toEqual(["true", false, true]);
    view.draw(quiet);
    expect([root.dataset.alert, dot("mic").hidden]).toEqual(["false", true]);
  });
});

describe("what a one-glance style shows", () => {
  it("picks an alert, then a live activity, then the right spot, then the left", () => {
    const clock = { text: "00:41" };
    const cpu = { text: "62%" };
    expect(lead({ ...quiet, left: clock, right: cpu })?.glance).toBe(cpu);
    expect(lead({ ...quiet, left: clock })?.glance).toBe(clock);
    const song = { text: "Song", wide: true };
    expect(lead({ ...quiet, left: song, right: cpu })?.glance).toBe(song);
    const done = { text: "Done", tone: "alert" as const };
    expect(lead({ ...quiet, left: done, right: song })?.glance).toBe(done);
    expect(lead(quiet)).toBeNull();
  });

  it("finds the mic or camera, and progress from the most important glance first", () => {
    expect(privacy({ ...quiet, left: { text: "Zoom", mark: "camera" } })?.glance.mark).toBe("camera");
    expect(privacy({ ...quiet, left: { text: "Song", mark: "eq" } })).toBeNull();
    expect(progressOf({ ...quiet, left: { text: "a", progress: 0.2 }, right: { text: "b", level: 0.9 } })).toBe(0.9);
    expect(progressOf({ ...quiet, left: { text: "a", progress: 2 } })).toBe(1);
    expect(progressOf({ ...quiet, left: { text: "a" } })).toBeUndefined();
  });
});
