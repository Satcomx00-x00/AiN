import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const { area, sparkline } = await import("../core/chart");
const { isoWeek } = await import("./clock");
const { add, fmt, glanceOf, progress, remaining, settle, toggle } = await import("./timer");
const { ago, kindOf, preview } = await import("./clipboard");
const { fmtBytes, level } = await import("./stats");
const { tauriStats } = await import("./stats/api");
const { tauriClipboard } = await import("./clipboard/api");

const MIN = 60_000;

describe("clock", () => {
  it("Jan 1 2026 (Thursday) is week 1", () => expect(isoWeek(new Date(2026, 0, 1))).toBe(1));
  it("Dec 29 2025 belongs to 2026 week 1", () => expect(isoWeek(new Date(2025, 11, 29))).toBe(1));
  it("Jan 1 2027 (Friday) is week 53 of 2026", () => expect(isoWeek(new Date(2027, 0, 1))).toBe(53));
});

describe("timer", () => {
  const idle = { kind: "idle", duration: 5 * MIN } as const;

  it("starts, pauses and resumes keeping the remaining time", () => {
    const run = toggle(idle, 0);
    const paused = toggle(run, 2 * MIN);
    expect(remaining(paused, 99 * MIN)).toBe(3 * MIN);
    expect(remaining(toggle(paused, 10 * MIN), 11 * MIN)).toBe(2 * MIN);
  });

  it("finishes once the end time passes", () => {
    const run = toggle(idle, 0);
    expect(settle(run, 5 * MIN - 1).kind).toBe("running");
    expect(settle(run, 5 * MIN).kind).toBe("done");
  });

  it("does not start at zero", () => expect(toggle({ kind: "idle", duration: 0 }, 0).kind).toBe("idle"));

  it("adds time to a running timer", () => expect(remaining(add(toggle(idle, 0), MIN, 0), 0)).toBe(6 * MIN));

  it("adding after done starts a fresh countdown", () =>
    expect(add({ kind: "done", duration: 5 * MIN }, MIN, 0)).toEqual({ kind: "idle", duration: MIN }));

  it("reports progress from 0 to 1", () => {
    expect(progress(idle, 0)).toBe(0);
    expect(progress(toggle(idle, 0), 2.5 * MIN)).toBe(0.5);
    expect(progress({ kind: "done", duration: MIN }, 0)).toBe(1);
  });

  it("glances only while active, alerting when done", () => {
    expect(glanceOf(idle, 0)).toBeNull();
    expect(glanceOf(toggle(idle, 0), MIN)).toEqual({ text: "4:00", progress: expect.closeTo(0.2) });
    expect(glanceOf(toggle(toggle(idle, 0), MIN), MIN)?.tone).toBe("muted");
    expect(glanceOf({ kind: "done", duration: MIN }, 0)?.tone).toBe("alert");
  });

  it("formats minutes and hours", () => {
    expect(fmt(5 * MIN)).toBe("5:00");
    expect(fmt(5 * MIN - 1)).toBe("5:00");
    expect(fmt(61 * MIN + 2000)).toBe("1:01:02");
  });
});

describe("clipboard", () => {
  it("flattens whitespace", () => expect(preview("a\n\n  b\tc")).toBe("a b c"));
  it("truncates with an ellipsis", () => expect(preview("abcdef", 4)).toBe("abc…"));

  it.each([
    ["#0A84FF", "color"],
    ["rgb(10, 132, 255)", "color"],
    ["https://tauri.app/start", "url"],
    ["hello@example.com", "email"],
    ["1 234,56", "number"],
    ["fn main() {\n  run();\n}", "code"],
    ["just some words", "text"],
    ["#nothex", "text"],
  ] as const)("%s is %s", (text, kind) => expect(kindOf(text)).toBe(kind));

  it("formats relative times", () => {
    expect(ago(3_000)).toBe("now");
    expect(ago(42_000)).toBe("42s");
    expect(ago(5 * MIN)).toBe("5m");
    expect(ago(3 * 60 * MIN)).toBe("3h");
    expect(ago(50 * 60 * MIN)).toBe("2d");
  });
});

describe("stats", () => {
  it("formats bytes", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(16 * 1024 ** 3)).toBe("16 GB");
  });

  it("colors load by level", () => {
    expect(level(0.3)).toBe("ok");
    expect(level(0.7)).toBe("warn");
    expect(level(0.9)).toBe("hot");
  });
});

describe("chart", () => {
  it("draws newest values on the right edge, clamped to the box", () =>
    expect(sparkline([50, 150], 300, 20)).toBe(`${+(300 - 300 / 59).toFixed(1)},10 300,0`));
  it("closes the area down to the baseline", () => expect(area([0, 100], 10, 10, 100, 2)).toBe("0,10 10,0 10,10 0,10"));
  it("has no area without data", () => expect(area([], 10, 10)).toBe(""));
});

describe("backend adapters", () => {
  it("passes through a missing first stats sample", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    expect(await tauriStats.stats()).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("plugin:stats|latest");
  });

  it("copies through the clipboard plugin", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await tauriClipboard.copy("hi");
    expect(invoke).toHaveBeenLastCalledWith("plugin:clipboard|copy", { text: "hi" });
  });

  it("rejects a malformed history", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([{ text: 1 }]);
    await expect(tauriClipboard.history()).rejects.toThrow();
  });
});

describe("media", async () => {
  const { clip, elapsed, position } = await import("./media");
  const t = { title: "Song", artist: "A", album: "", app: "Spotify", playing: true, positionMs: 10_000, durationMs: 60_000, measuredAt: 1_000, artworkKey: "k" };

  it("extrapolates position while playing, clamped to the duration", () => {
    expect(position(t, 6_000)).toBe(15_000);
    expect(position(t, 999_999)).toBe(60_000);
    expect(position({ ...t, playing: false }, 6_000)).toBe(10_000);
  });

  it("formats elapsed time", () => {
    expect(elapsed(83_900)).toBe("1:23");
    expect(elapsed(3_723_000)).toBe("1:02:03");
  });

  it("clips long titles", () => expect(clip("Hurry Up, We're Dreaming", 10)).toBe("Hurry Up,…"));
});

describe("volume", async () => {
  const { changed, volumeGlance } = await import("./volume");
  const out = { level: 0.5, muted: false, device: "Speakers" };

  it("pops up only briefly after a change", () => {
    expect(volumeGlance(out, 1_000, 1_500)).toEqual({ text: "50%", level: 0.5, wide: true });
    expect(volumeGlance(out, 1_000, 3_000)).toBeNull();
    expect(volumeGlance({ ...out, muted: true }, 1_000, 1_500)?.text).toBe("Muted");
  });

  it("the first reading is not a change", () => {
    expect(changed(null, out)).toBe(false);
    expect(changed(out, { ...out, device: "Headphones" })).toBe(false);
    expect(changed(out, { ...out, level: 0.6 })).toBe(true);
  });
});

describe("privacy", async () => {
  const { filter, privacyGlance } = await import("./privacy");

  it("shows nothing when nothing is in use", () => expect(privacyGlance({ mic: [], camera: [] })).toBeNull());

  it("names a single app and marks the mic", () => expect(privacyGlance({ mic: ["Discord"], camera: [] })).toEqual({ text: "Discord", mark: "mic" }));

  it("counts apps and lets the camera win the mark", () =>
    expect(privacyGlance({ mic: ["Discord", "Zoom"], camera: ["Zoom"] })).toEqual({ text: "2 apps", mark: "camera" }));

  it("drops ignored background services", () =>
    expect(filter({ mic: ["Discord", "SteelSeriesSonar"], camera: [] }, new Set(["SteelSeriesSonar"]))).toEqual({ mic: ["Discord"], camera: [] }));
});

describe("volume mixer", async () => {
  const { shortName, shown, togglePin } = await import("./volume");
  const src = (name: string, extra: { default?: boolean } = {}) => ({
    id: `device:${name}`,
    kind: "device" as const,
    name,
    level: 1,
    muted: false,
    default: extra.default ?? false,
    active: true,
  });
  const sources = [src("SteelSeries Sonar - Gaming (SteelSeries Sonar Virtual Audio Device)", { default: true }), src("Speakers (Realtek Audio)"), src("Spotify")];

  it("drops the driver name in parentheses", () => {
    expect(shortName("SteelSeries Sonar - Gaming (SteelSeries Sonar Virtual Audio Device)")).toBe("SteelSeries Sonar - Gaming");
    expect(shortName("Spotify")).toBe("Spotify");
  });

  it("shows the default output until something is pinned", () => expect(shown(sources, []).map((s) => s.name)).toEqual([sources[0]?.name]));

  it("shows pinned sources in pin order, skipping ones that are gone", () =>
    expect(shown(sources, ["Spotify", "Missing", "Speakers"]).map((s) => shortName(s.name))).toEqual(["Spotify", "Speakers"]));

  it("toggles a pin", () => {
    expect(togglePin(["A"], "B")).toEqual(["A", "B"]);
    expect(togglePin(["A", "B"], "A")).toEqual(["B"]);
  });
});

describe("privacy chips", async () => {
  const { chipsFor } = await import("./privacy");
  it("folds extra apps into a count", () => {
    expect(chipsFor(["Discord"])).toEqual({ shown: ["Discord"], more: 0 });
    expect(chipsFor(["A", "B", "C", "D", "E"])).toEqual({ shown: ["A", "B", "C"], more: 2 });
  });
});

describe("smooth curve", async () => {
  const { curve, curveArea } = await import("../core/chart");
  it("starts at the oldest point, curves through each, and closes the area to the baseline", () => {
    const d = curve([0, 100, 0], 20, 10, 100, 3);
    expect(d.startsWith("M0,10 C")).toBe(true);
    expect(d.endsWith(" 20,10")).toBe(true);
    expect(d.match(/C/g)).toHaveLength(2);
    expect(curveArea([0, 100, 0], 20, 10, 100, 3).endsWith("L20,10 L0,10 Z")).toBe(true);
    expect(curve([], 20, 10)).toBe("");
  });
});

describe("dictation", async () => {
  const { clock, dictationGlance, mb, modelLine, nextModel, shortPath } = await import("./dictation");

  it("shortens long model paths from the start", () => {
    expect(shortPath("C:/a", 10)).toBe("C:/a");
    expect(shortPath("C:/Users/me/models", 10)).toBe("…me/models");
  });
  const { ModelInfoSchema, ModelSchema, PhaseSchema } = await import("./dictation/api");
  const { catalogue } = await import(".");
  const { bindings } = await import("../core/commands");

  it("shows a live recording on the pill, then a brief result", () => {
    expect(dictationGlance({ phase: "listening", level: 0.4, seconds: 65 }, 0, 1)).toEqual({ text: "1:05", mark: "rec", level: 0.4, wide: true });
    expect(dictationGlance({ phase: "done", text: "Hi" }, 1000, 2000)?.text).toBe("Typed");
    expect(dictationGlance({ phase: "done", text: "" }, 1000, 2000)?.text).toBe("Nothing heard");
    expect(dictationGlance({ phase: "done", text: "Hi" }, 1000, 9000)).toBeNull();
    expect(dictationGlance({ phase: "idle" }, 0, 0)).toBeNull();
  });

  it("describes the model download", () => {
    const at = { model: "whisper-small", dir: "D:/Models/whisper-small-int8", installed: [] };
    expect(modelLine({ ...at, state: "downloading", received: 335e6, total: 670e6 })).toEqual({
      title: "Whisper small",
      detail: "Downloading… 335 MB of 670 MB",
      progress: 0.5,
    });
    expect(modelLine({ ...at, state: "missing", size: 375e6 }).detail).toBe("99 languages, a good balance");
    expect(modelLine({ ...at, model: "gone", state: "ready" }).title).toBe("Parakeet TDT v3");
    expect(mb(0)).toBe("0 MB");
    expect(clock(9)).toBe("0:09");
  });

  it("parses what the backend sends", () => {
    expect(PhaseSchema.parse({ phase: "needsModel" })).toEqual({ phase: "needsModel" });
    expect(ModelSchema.parse({ state: "ready" })).toEqual({ state: "ready" });
    const info = { state: "missing", size: 1, model: "parakeet-v3", dir: "D:\\Models", installed: ["whisper-base"] };
    expect(ModelInfoSchema.parse(info)).toEqual(info);
  });

  it("cycles through the speech models", () => {
    expect(nextModel("parakeet-v3", 1)).toBe("parakeet-v2");
    expect(nextModel("parakeet-v3", -1)).toBe("moonshine-base");
    expect(nextModel("moonshine-base", 1)).toBe("parakeet-v3");
    expect(nextModel("gone", 1)).toBe("parakeet-v2");
  });

  it("binds its shortcut as an action, with no popup", () => {
    expect(bindings(catalogue, {})["dictation.toggle"]).toEqual({ shortcut: "Ctrl+Alt+KeyD", surface: "action" });
  });
});
