// @vitest-environment happy-dom
/**
 * Read aloud: the voice model is chosen, downloaded and stored in Settings, along with its voice;
 * the island reads the selection on the shortcut, and the last text again from its tab.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { SAMPLE, modelOptions, reading, statusText, tts, ttsGlance, voiceOptions } = await import(".");
const { MODELS } = await import("./models");
const { bindings } = await import("../../shell/commands");
const { catalogue } = await import("..");
const { memoryProviders } = await import("../../shell/providers");
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

  it("lets problems fade from the pill, but shows a failure while it is fresh", () => {
    expect(ttsGlance({ phase: "needsModel" }, 1000, 9000)).toBeNull();
    expect(ttsGlance({ phase: "nothingSelected" }, 1000, 9000)).toBeNull();
    expect(ttsGlance({ phase: "error", message: "x" }, 1000, 2000)).toEqual({ text: "Reading failed", tone: "alert" });
  });

  it("says what to do in each phase", () => {
    expect(statusText({ phase: "idle" }, "")).toContain("Ctrl+Alt+R");
    expect(statusText({ phase: "needsModel" }, "")).toBe("Choose and download a voice in Settings to start reading.");
    expect(statusText({ phase: "nothingSelected" }, "")).toBe("No text is selected. Select some, then press the shortcut again.");
    expect(statusText({ phase: "preparing" }, "")).toBe("Preparing the voice…");
  });

  it("binds its shortcut as an action, with no popup", () => {
    expect(bindings(catalogue, {})["tts.read"]).toEqual({ shortcut: "Ctrl+Alt+KeyR", surface: "action" });
  });
});

describe("in the island", () => {
  const mount = (options: object = {}, providers = memoryProviders()) => {
    const fake = fakePort();
    const host = { refresh: vi.fn(), options: () => options as never, setOptions: vi.fn(), secret: async () => "", openSettings: vi.fn(), openPage: vi.fn(), appearance: () => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }) as const, notify: () => ({ id: "", update() {}, dismiss() {} }), on: () => () => {} };
    const widget = tts.setup({ tts: fake.port, providers } as never, host);
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

  it("reads with a provider's voice without its own being downloaded", async () => {
    const lab = { id: "lab", name: "Lab", preset: "custom", baseUrl: "http://lab/v1", auth: { kind: "none" } } as const;
    const { root, phase, model, main } = mount({ engine: "lab", remoteModel: "kokoro" }, memoryProviders([lab]));
    model({ ...at, state: "missing", size: 305e6 });
    phase({ phase: "speaking", text: "Hello" });
    phase({ phase: "idle" });
    await tick();
    expect(root.querySelector(".dict-model strong")?.textContent).toBe("Lab · kokoro");
    expect(main.disabled).toBe(false);
  });

  it("stays put when the backend refuses to read", async () => {
    const { port, phase, model, main } = mount();
    model({ ...at, state: "ready" });
    phase({ phase: "speaking", text: "Hello" });
    phase({ phase: "idle" });
    port.speak.mockRejectedValueOnce(new Error("no speakers"));
    main.click();
    await tick();
    expect([port.speak.mock.calls, main.disabled]).toEqual([[["Hello"]], false]);
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
    const host = { options: () => ({ engine: "", remoteModel: "", remoteVoice: "", model: "kokoro-en", voice, speed: 1, modelDir: "", keepLoaded: false }), setOptions: vi.fn(), openPage: vi.fn() };
    const cleanup = tts.settingsPanel?.(root, { tts: fake.port, providers: memoryProviders() } as never, host);
    const [, models, voices] = root.querySelectorAll<HTMLElement>(".ui-select");
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
    expect(voiceOptions("piper-fr-upmc").map((v) => v.label)).toEqual(["Jessica (female)", "Pierre (male)"]);
    expect(voiceOptions("kokoro-fr")).toEqual([]);
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

  it("saves the voice picked in the list", async () => {
    const { root, host, voices, model } = mount();
    model({ ...at, state: "ready" });
    voices.querySelector<HTMLButtonElement>(".ui-select-trigger")!.click();
    [...root.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent?.startsWith("Adam"))?.click();
    expect(host.setOptions).toHaveBeenCalledWith({ voice: 5 });
  });

  it("stays put when trying the voice fails", async () => {
    const { root, port, model } = mount();
    model({ ...at, state: "ready" });
    port.speak.mockRejectedValueOnce(new Error("no speakers"));
    named(root, "Try the voice")?.click();
    await tick();
    expect(port.speak).toHaveBeenCalledWith(SAMPLE);
  });

  it("offers the default model's voices for an unknown model", () => expect(voiceOptions("gone")).toEqual(voiceOptions("kokoro-en")));

  it("has nothing to stop when the model couldn't be watched", async () => {
    const fake = fakePort();
    fake.port.watchModel.mockRejectedValueOnce(new Error("backend gone"));
    const host = { options: () => ({ engine: "", remoteModel: "", remoteVoice: "", model: "kokoro-en", voice: 0, speed: 1, modelDir: "", keepLoaded: false }), setOptions: vi.fn(), openPage: vi.fn() };
    const cleanup = tts.settingsPanel?.(document.createElement("div"), { tts: fake.port, providers: memoryProviders() } as never, host);
    expect(() => (cleanup as () => void)()).not.toThrow();
    await tick();
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
    expect(tts.options?.keepLoaded).toMatchObject({ kind: "toggle", default: false });
  });
});

describe("the voice models listed in Settings", () => {
  it("say which are downloaded", () => {
    const [first, second] = MODELS;
    const listed = modelOptions([first!.id]);
    expect(listed.find((o) => o.value === first!.id)?.badge).toBe("Downloaded");
    expect(listed.find((o) => o.value === second!.id)?.badge).toBeUndefined();
  });
});
