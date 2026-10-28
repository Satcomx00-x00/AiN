// @vitest-environment happy-dom
/** Writing down the computer's sound: the tab, the pill, and the engine picked in Settings. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { transcript, transcriptGlance, statusText, asText, timeOf } = await import(".");
const { phase: fromWire } = await import("./service");
const { memoryProviders } = await import("../../shell/providers");
const { bindings } = await import("../../shell/commands");
const { catalogue } = await import("..");
import type { Line, Phase, TranscriptPort } from "./service";

const tick = () => new Promise((r) => setTimeout(r));
const at = new Date(2026, 9, 27, 14, 5, 9).getTime();
const LINES: Line[] = [
  { at, text: "Hello there." },
  { at: at + 4000, text: "How are you?" },
];

function mount(options: { times?: boolean } = {}) {
  let pushPhase: (p: Phase) => void = () => {};
  let pushLines: (l: readonly Line[]) => void = () => {};
  const port = {
    watch: vi.fn(async (onChange: (p: Phase) => void) => ((pushPhase = onChange), onChange({ phase: "idle" }), () => {})),
    watchLines: vi.fn(async (onChange: (l: readonly Line[]) => void) => ((pushLines = onChange), onChange([]), () => {})),
    control: vi.fn(async () => {}),
  } satisfies TranscriptPort;
  const clipboard = { copy: vi.fn(async () => {}) };
  const host = { refresh: vi.fn(), options: () => ({ engine: "", remoteModel: "", times: true, ...options }) as never, setOptions: vi.fn(), secret: async () => "", openSettings: vi.fn(), openPage: vi.fn(), appearance: () => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }) as const };
  const widget = transcript.setup({ transcript: port, clipboard, providers: memoryProviders() } as never, host);
  const root = document.createElement("section");
  widget.panel?.(root);
  const named = (text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  return { root, port, clipboard, host, widget, named, phase: (p: Phase) => pushPhase(p), lines: (l: readonly Line[]) => pushLines(l) };
}

describe("in the island", () => {
  it("starts and stops listening from its button", async () => {
    const { root, port, phase } = mount();
    const main = root.querySelector<HTMLButtonElement>(".dict-main")!;
    expect(main.getAttribute("aria-label")).toBe("Start transcribing");
    main.click();
    expect(port.control).toHaveBeenCalledWith("toggle");
    phase({ phase: "listening", level: 0.4, seconds: 3 });
    expect(main.dataset.state).toBe("rec");
    expect(main.getAttribute("aria-label")).toBe("Stop transcribing");
    expect(root.querySelector<HTMLElement>(".dict-level")?.hidden).toBe(false);
    phase({ phase: "listening", level: 0.5, seconds: 4 });
    phase({ phase: "finishing" });
    expect(main.disabled).toBe(true);
    expect(main.getAttribute("aria-label")).toBe("Start transcribing");
  });

  it("lists the lines heard, with their time, and follows the newest", async () => {
    const { root, lines, named } = mount();
    expect(named("Copy")?.hidden).toBe(true);
    lines(LINES);
    const items = [...root.querySelectorAll(".ts-lines li")];
    expect(items.map((li) => li.querySelector("span")?.textContent)).toEqual(["Hello there.", "How are you?"]);
    expect(items[0]?.querySelector("time")?.textContent).toBe(timeOf(at));
    expect(named("Copy")?.hidden).toBe(false);
    expect(root.querySelector(".dict-status")?.textContent).toBe("2 lines heard.");
  });

  it("stays where the user scrolled up to read", () => {
    const { root, lines } = mount();
    const list = root.querySelector<HTMLElement>(".ts-lines")!;
    Object.defineProperty(list, "scrollHeight", { value: 500, configurable: true });
    list.scrollTop = 100;
    lines(LINES);
    expect(list.scrollTop).toBe(100);
  });

  it("leaves the times out when they are turned off", () => {
    const { root, lines } = mount({ times: false });
    lines(LINES.slice(0, 1));
    expect(root.querySelector(".ts-lines time")).toBeNull();
    expect(root.querySelector(".dict-status")?.textContent).toBe("1 line heard.");
  });

  it("copies the transcript and clears it", async () => {
    const { port, clipboard, lines, named } = mount();
    lines(LINES);
    named("Copy")?.click();
    expect(clipboard.copy).toHaveBeenCalledWith(asText(LINES, true));
    named("Clear")?.click();
    expect(port.control).toHaveBeenCalledWith("clear");
  });

  it("keeps quiet when the backend refuses", async () => {
    const { root, port, clipboard, lines, named } = mount();
    port.control.mockRejectedValue(new Error("gone"));
    clipboard.copy.mockRejectedValue(new Error("no clipboard"));
    lines(LINES);
    root.querySelector<HTMLButtonElement>(".dict-main")?.click();
    named("Copy")?.click();
    named("Clear")?.click();
    await tick();
    expect(port.control).toHaveBeenCalledTimes(2);
  });

  it("tints the island while listening", () => {
    const { widget, phase } = mount();
    expect(widget.ambient?.()).toBeNull();
    phase({ phase: "listening", level: 0, seconds: 0 });
    expect(widget.ambient?.()).toBe("#ff453a");
  });

  it("shows on the pill while listening", () => {
    const { widget, phase } = mount();
    phase({ phase: "listening", level: 0.2, seconds: 65 });
    expect(widget.glance?.(Date.now())).toMatchObject({ text: "1:05", mark: "rec" });
  });
});

describe("on the pill", () => {
  it("shows the time while listening, then problems for a moment", () => {
    expect(transcriptGlance({ phase: "idle" }, 0, 0)).toBeNull();
    expect(transcriptGlance({ phase: "finishing" }, 0, 0)).toMatchObject({ text: "Finishing…" });
    expect(transcriptGlance({ phase: "needsModel" }, 0, 1000)).toMatchObject({ tone: "alert" });
    expect(transcriptGlance({ phase: "needsModel" }, 0, 6000)).toBeNull();
    expect(transcriptGlance({ phase: "error", message: "x" }, 0, 1000)).toMatchObject({ text: "Transcript failed" });
    expect(transcriptGlance({ phase: "error", message: "x" }, 0, 6000)).toBeNull();
  });
});

describe("its status", () => {
  it("says what it is doing", () => {
    expect(statusText({ phase: "idle" }, 0)).toContain("Ctrl+Alt+H");
    expect(statusText({ phase: "needsModel" }, 0)).toContain("speech model");
    expect(statusText({ phase: "listening", level: 0, seconds: 0 }, 0)).toContain("Listening");
    expect(statusText({ phase: "finishing" }, 3)).toContain("last words");
    expect(statusText({ phase: "error", message: "No PipeWire" }, 0)).toBe("No PipeWire");
  });

  it("writes the transcript as text", () => {
    expect(asText(LINES, false)).toBe("Hello there.\nHow are you?");
    expect(asText(LINES, true)).toBe(`[${timeOf(at)}] Hello there.\n[${timeOf(at + 4000)}] How are you?`);
  });

  it("reads the backend's phase, with a missing level as silence", () => {
    expect(fromWire({ phase: "listening", level: null, seconds: null })).toEqual({ phase: "listening", level: 0, seconds: 0 });
    expect(fromWire({ phase: "idle" })).toEqual({ phase: "idle" });
  });
});

describe("in Settings", () => {
  it("picks dictation's model or a provider", () => {
    const root = document.createElement("div");
    const host = { options: () => ({ engine: "", remoteModel: "", times: true }), setOptions: vi.fn() };
    const stop = transcript.settingsPanel?.(root, { providers: memoryProviders() } as never, host as never);
    expect(root.textContent).toContain("Dictation's speech model");
    expect(typeof stop).toBe("function");
    (stop as () => void)();
  });

  it("starts and stops from its shortcut", () => {
    expect(bindings(catalogue, {})["transcript.toggle"]).toEqual({ shortcut: "Ctrl+Alt+KeyH", surface: "action" });
  });
});
