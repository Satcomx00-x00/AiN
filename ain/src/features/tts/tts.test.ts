// @vitest-environment happy-dom
/**
 * Read aloud: the voice model is chosen, downloaded and stored in Settings, along with its voice;
 * the island reads the selection on the shortcut, and the last text again from its tab.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { reading, statusText, tts, ttsGlance, voiceOptions } = await import(".");
const { bindings } = await import("../../shell/commands");
const { catalogue } = await import("..");
import type { ModelInfo, Phase, TtsPort } from "./service";

const at = { model: "kokoro-en", dir: "D:/Models/kokoro-en-v0_19", installed: [] };

/** A read aloud backend whose phase and model status can be pushed by the test. */
function fakePort() {
  let pushPhase: (phase: Phase) => void = () => {};
  let pushModel: (info: ModelInfo) => void = () => {};
  const stop = vi.fn();
  const port = {
    watch: vi.fn(async (onChange: (phase: Phase) => void) => ((pushPhase = onChange), onChange({ phase: "idle" }), () => {})),
    watchModel: vi.fn(async (onChange: (info: ModelInfo) => void) => ((pushModel = onChange), stop)),
    openFolder: vi.fn(async () => {}),
    control: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  } satisfies TtsPort;
  return { port, stop, phase: (p: Phase) => pushPhase(p), model: (info: ModelInfo) => pushModel(info) };
}

const tick = () => new Promise((r) => setTimeout(r));
const named = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text);

describe("on the pill", () => {
  it("shows the reading while it lasts, and problems briefly", () => {
    expect(ttsGlance({ phase: "speaking", text: "Hi" }, 0, 99_000)).toEqual({ text: "Reading aloud", mark: "eq", wide: true });
    expect(ttsGlance({ phase: "preparing" }, 0, 99_000)?.text).toBe("Preparing…");
    expect(ttsGlance({ phase: "nothingSelected" }, 1000, 2000)?.text).toBe("Select text first");
    expect(ttsGlance({ phase: "needsModel" }, 1000, 2000)?.tone).toBe("alert");
    expect(ttsGlance({ phase: "error", message: "x" }, 0, 9000)).toBeNull();
    expect(ttsGlance({ phase: "idle" }, 0, 0)).toBeNull();
  });

  it("says what is read, and what went wrong", () => {
    expect(statusText({ phase: "speaking", text: "Hi" }, "")).toBe("“Hi”");
    expect(statusText({ phase: "idle" }, "Hi")).toBe("“Hi”");
    expect(statusText({ phase: "error", message: "No speakers found" }, "")).toBe("No speakers found");
    expect(reading({ phase: "preparing" }) && !reading({ phase: "idle" })).toBe(true);
  });

  it("binds its shortcut as an action, with no popup", () => {
    expect(bindings(catalogue, {})["tts.read"]).toEqual({ shortcut: "Ctrl+Alt+KeyR", surface: "action" });
  });
});

describe("in the island", () => {
  const mount = () => {
    const fake = fakePort();
    const host = { refresh: vi.fn(), options: () => ({}) as never, setOptions: vi.fn(), secret: async () => "", openSettings: vi.fn(), openPage: vi.fn(), appearance: () => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }) as const };
    const widget = tts.setup({ tts: fake.port } as never, host);
    const root = document.createElement("section");
    widget.panel?.(root);
    const main = root.querySelector<HTMLButtonElement>(".dict-main")!;
    return { ...fake, root, host, main };
  };

  it("reads the last text again, or stops a reading", async () => {
    const { port, phase, model, main } = mount();
    model({ ...at, state: "ready" });
    await tick();
    expect(main.disabled).toBe(true);
    phase({ phase: "speaking", text: "Hello" });
    expect(main.getAttribute("aria-label")).toBe("Stop reading");
    main.click();
    expect(port.control).toHaveBeenCalledWith("stop");
    phase({ phase: "idle" });
    main.click();
    expect(port.speak).toHaveBeenCalledWith("Hello");
  });

  it("sends the user to Settings to set the voice up", async () => {
    const { root, host, model } = mount();
    model({ ...at, state: "missing", size: 305e6 });
    await tick();
    expect(root.querySelector(".dict-model")?.textContent).toContain("Kokoro");
    named(root, "Set up in Settings")?.click();
    expect(host.openSettings).toHaveBeenCalledOnce();
  });
});

describe("in Settings", () => {
  const mount = (voice = 0) => {
    const fake = fakePort();
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const host = { options: () => ({ model: "kokoro-en", voice, speed: 1, modelDir: "" }), setOptions: vi.fn(), openPage: vi.fn() };
    const cleanup = tts.settingsPanel?.(root, { tts: fake.port } as never, host);
    const [models, voices] = root.querySelectorAll<HTMLElement>(".ui-select");
    return { ...fake, root, host, cleanup, models: models!, voices: voices! };
  };

  it("lists each model's voices, and hides them for one-voice models", async () => {
    const { model, voices } = mount(3);
    await tick();
    model({ ...at, state: "ready" });
    expect(voices.querySelector(".ui-select-trigger")?.textContent).toContain("Sarah (US, female)");
    model({ ...at, model: "piper-fr-siwis", state: "ready" });
    expect(voices.closest<HTMLElement>(".field")?.hidden).toBe(true);
    expect(voiceOptions("kitten-nano")).toHaveLength(8);
  });

  it("starts the new model on its first voice", async () => {
    const { root, host, models } = mount(4);
    models.querySelector<HTMLButtonElement>(".ui-select-trigger")!.click();
    [...root.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent?.startsWith("Kitten nano"))?.click();
    expect(host.setOptions).toHaveBeenCalledWith({ model: "kitten-nano", voice: 0 });
  });

  it("downloads the model, then lets the voice be tried", async () => {
    const { root, port, model } = mount();
    await tick();
    model({ ...at, state: "missing", size: 305e6 });
    expect(named(root, "Try the voice")?.disabled).toBe(true);
    named(root, "Download · 305 MB")?.click();
    expect(port.download).toHaveBeenCalledOnce();
    model({ ...at, state: "ready" });
    named(root, "Try the voice")?.click();
    expect(port.speak).toHaveBeenCalledOnce();
  });

  it("stops watching the model when the card goes away", async () => {
    const { stop, cleanup } = mount();
    (cleanup as () => void)();
    await tick();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("its settings", () => {
  it("keep the model and voice for the panel, the rest as standard controls", () => {
    expect(tts.options?.model.inPanel).toBe(true);
    expect(tts.options?.voice.inPanel).toBe(true);
    expect(tts.options?.speed.default).toBe(1);
    expect(tts.options?.modelDir.kind).toBe("folder");
  });
});
