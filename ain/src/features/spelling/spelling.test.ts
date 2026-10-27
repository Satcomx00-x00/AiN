// @vitest-environment happy-dom
/**
 * Spelling: the dictionaries are downloaded (or a provider chosen) in Settings, where a correction
 * can be tried; the island corrects the selection on the shortcut and shows what changed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), once: vi.fn(), emit: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const { listen } = await import("@tauri-apps/api/event");
const { DICTIONARIES, fixes, spelling, spellingGlance, statusText } = await import(".");
const { tauriSpelling } = await import("./service");
const { bindings } = await import("../../shell/commands");
const { catalogue } = await import("..");
const { memoryProviders } = await import("../../shell/providers");
import type { ModelInfo, Phase, SpellingPort } from "./service";

const at = { model: "hunspell-fr-en", dir: "D:/Models/hunspell-fr-en", installed: [] };
const done = (fixes: number, delivery: "typed" | "copied" | null): Phase => ({ phase: "done", original: "teh cat", corrected: "the cat", fixes, delivery });

/** A spelling backend whose phase and dictionaries' status can be pushed by the test. */
function fakePort() {
  let pushPhase: (phase: Phase) => void = () => {};
  let pushModel: (info: ModelInfo) => void = () => {};
  const stop = vi.fn();
  const port = {
    watch: vi.fn(async (onChange: (phase: Phase) => void) => ((pushPhase = onChange), onChange({ phase: "idle" }), () => {})),
    watchModel: vi.fn(async (onChange: (info: ModelInfo) => void) => ((pushModel = onChange), stop)),
    fix: vi.fn(async () => {}),
    check: vi.fn(async (text: string) => ({ text: text.replace("teh", "the"), fixes: text.includes("teh") ? 1 : 0 })),
    openFolder: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  } satisfies SpellingPort;
  return { port, stop, phase: (p: Phase) => pushPhase(p), model: (info: ModelInfo) => pushModel(info) };
}

const tick = () => new Promise((r) => setTimeout(r));
const named = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text);

describe("on the pill", () => {
  it("shows the correction while it runs, then how it went, briefly", () => {
    expect(spellingGlance({ phase: "checking" }, 0, 99_000)).toEqual({ text: "Correcting…", mark: "eq", wide: true });
    expect(spellingGlance(done(1, "typed"), 1000, 2000)).toEqual({ text: "1 fix", tone: "muted" });
    expect(spellingGlance(done(3, "copied"), 1000, 2000)?.text).toBe("3 fixes · copied");
    expect(spellingGlance(done(0, null), 1000, 2000)?.text).toBe("No mistakes");
    expect(spellingGlance(done(1, "typed"), 0, 9000)).toBeNull();
    expect(spellingGlance({ phase: "idle" }, 0, 0)).toBeNull();
  });

  it("shows problems while they are fresh", () => {
    expect(spellingGlance({ phase: "needsModel" }, 1000, 2000)?.tone).toBe("alert");
    expect(spellingGlance({ phase: "nothingSelected" }, 1000, 2000)?.text).toBe("Select text first");
    expect(spellingGlance({ phase: "error", message: "x" }, 1000, 2000)).toEqual({ text: "Correction failed", tone: "alert" });
    for (const phase of ["needsModel", "nothingSelected"] as const) expect(spellingGlance({ phase }, 1000, 9000)).toBeNull();
    expect(spellingGlance({ phase: "error", message: "x" }, 1000, 9000)).toBeNull();
  });

  it("says what to do in each phase", () => {
    expect(statusText({ phase: "idle" })).toContain("Ctrl+Alt+O");
    expect(statusText({ phase: "needsModel" })).toContain("Download the dictionaries");
    expect(statusText({ phase: "nothingSelected" })).toContain("No text is selected");
    expect(statusText({ phase: "checking" })).toBe("Correcting…");
    expect(statusText(done(2, "typed"))).toBe("2 fixes, typed over the selection.");
    expect(statusText(done(1, "copied"))).toBe("1 fix, copied: paste it where you want it.");
    expect(statusText(done(0, null))).toBe("No mistakes found.");
    expect(statusText({ phase: "error", message: "The provider answered 500" })).toBe("The provider answered 500");
    expect([fixes(1), fixes(0)]).toEqual(["1 fix", "0 fixes"]);
  });

  it("binds its shortcut as an action, with no popup", () => {
    expect(bindings(catalogue, {})["spelling.fix"]).toEqual({ shortcut: "Ctrl+Alt+KeyO", surface: "action" });
  });
});

describe("in the island", () => {
  const mount = (options: object = { engine: "", remoteModel: "" }, providers = memoryProviders()) => {
    const fake = fakePort();
    const host = { refresh: vi.fn(), options: () => options as never, setOptions: vi.fn(), secret: async () => "", openSettings: vi.fn(), openPage: vi.fn(), appearance: () => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }) as const };
    const widget = spelling.setup({ spelling: fake.port, providers } as never, host);
    const root = document.createElement("section");
    widget.panel?.(root);
    return { ...fake, root, host, widget };
  };

  it("shows what was corrected, and nothing when it was right", async () => {
    const { root, phase, host, widget } = mount();
    phase(done(1, "typed"));
    expect(root.querySelector(".dict-status")?.textContent).toBe("1 fix, typed over the selection.");
    expect(root.querySelector(".muted:not([hidden])")?.textContent).toBe("“teh cat”");
    expect(root.querySelector(".dict-quote")?.textContent).toBe("“the cat”");
    expect(host.refresh).toHaveBeenCalled();
    expect(widget.glance?.(Date.now())?.text).toBe("1 fix");
    phase(done(0, null));
    expect(root.querySelector<HTMLElement>(".dict-quote")?.hidden).toBe(true);
  });

  it("names the dictionaries, or the provider's model in their place", async () => {
    const { root, model } = mount();
    model({ ...at, state: "missing", size: 2e6 });
    await tick();
    expect(root.querySelector(".dict-model strong")?.textContent).toBe(DICTIONARIES);
    const lab = { id: "lab", name: "Lab", preset: "custom", baseUrl: "http://lab/v1", auth: { kind: "none" } } as const;
    const remote = mount({ engine: "lab", remoteModel: "gpt-4.1-mini" }, memoryProviders([lab]));
    remote.model({ ...at, state: "missing", size: 2e6 });
    await tick();
    expect(remote.root.querySelector(".dict-model strong")?.textContent).toBe("Lab · gpt-4.1-mini");
    expect(remote.root.querySelector<HTMLElement>(".dict-model")?.dataset.state).toBe("ready");
  });

  it("sends the user to Settings to get the dictionaries", async () => {
    const { root, host, model } = mount();
    model({ ...at, state: "missing", size: 2e6 });
    named(root, "Set up in Settings")?.click();
    expect(host.openSettings).toHaveBeenCalledOnce();
  });
});

describe("in Settings", () => {
  const mount = (engine = "") => {
    const fake = fakePort();
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const host = { options: () => ({ engine, remoteModel: "", language: "auto", apply: "replace", modelDir: "" }), setOptions: vi.fn(), openPage: vi.fn() };
    const cleanup = spelling.settingsPanel?.(root, { spelling: fake.port, providers: memoryProviders() } as never, host);
    const input = root.querySelector<HTMLInputElement>("input[aria-label='Text to correct']")!;
    return { ...fake, root, host, cleanup: cleanup as () => void, input, result: () => root.querySelector(".engine ~ .field-hint")?.textContent };
  };

  it("downloads the dictionaries, then lets a correction be tried", async () => {
    const { root, port, model, input, result } = mount();
    await tick();
    model({ ...at, state: "missing", size: 1_983_851 });
    expect(named(root, "Correct")?.disabled).toBe(true);
    named(root, "Download · 2 MB")?.click();
    expect(port.download).toHaveBeenCalledOnce();
    model({ ...at, state: "ready" });
    named(root, "Correct")?.click();
    expect(port.check).not.toHaveBeenCalled();
    input.value = " teh cat ";
    named(root, "Correct")?.click();
    expect(result()).toBe("Correcting…");
    await tick();
    expect(port.check).toHaveBeenCalledWith("teh cat");
    expect(result()).toBe("the cat (1 fix)");
    input.value = "fine";
    named(root, "Correct")?.click();
    await tick();
    expect(result()).toBe("No mistakes found.");
    port.check.mockRejectedValueOnce("Download the dictionaries in Settings first");
    named(root, "Correct")?.click();
    await tick();
    expect(result()).toBe("Download the dictionaries in Settings first");
  });

  it("hides the dictionaries when a provider corrects", async () => {
    const { root, model } = mount("lab");
    model({ ...at, state: "missing", size: 2e6 });
    expect(named(root, "Correct")?.disabled).toBe(false);
    expect(root.querySelector<HTMLElement>(".engine + .field")?.hidden).toBe(true);
  });

  it("stops watching when the card goes away, even if watching failed", async () => {
    const { stop, cleanup } = mount();
    cleanup();
    await tick();
    expect(stop).toHaveBeenCalledOnce();
    const fake = fakePort();
    fake.port.watchModel.mockRejectedValueOnce(new Error("backend gone"));
    const host = { options: () => ({ engine: "", remoteModel: "", language: "auto", apply: "replace", modelDir: "" }), setOptions: vi.fn(), openPage: vi.fn() };
    const failed = spelling.settingsPanel?.(document.createElement("div"), { spelling: fake.port, providers: memoryProviders() } as never, host) as () => void;
    expect(() => failed()).not.toThrow();
    await tick();
  });
});

describe("its settings", () => {
  it("leave the engine to the panel, the rest as standard controls", () => {
    expect(spelling.options?.engine.inPanel).toBe(true);
    expect(spelling.options?.language).toMatchObject({ kind: "choice", default: "auto" });
    expect(spelling.options?.apply).toMatchObject({ kind: "choice", default: "replace" });
    expect(spelling.options?.modelDir.kind).toBe("folder");
  });
});

describe("the backend adapter", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it("calls each command by its Rust name", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await tauriSpelling.fix();
    expect(invoke).toHaveBeenLastCalledWith("plugin:spelling|fix");
    await tauriSpelling.download();
    expect(invoke).toHaveBeenLastCalledWith("plugin:spelling|download_model");
    await tauriSpelling.remove();
    expect(invoke).toHaveBeenLastCalledWith("plugin:spelling|delete_model");
    await tauriSpelling.openFolder();
    expect(invoke).toHaveBeenLastCalledWith("plugin:spelling|open_model_dir");
    vi.mocked(invoke).mockResolvedValueOnce({ text: "the", fixes: 1 });
    expect(await tauriSpelling.check("teh")).toEqual({ text: "the", fixes: 1 });
    expect(invoke).toHaveBeenLastCalledWith("plugin:spelling|check", { text: "teh" });
  });

  it("follows the phase and the dictionaries", async () => {
    vi.mocked(listen).mockImplementation(async () => () => {});
    vi.mocked(invoke).mockResolvedValueOnce({ phase: "idle" }).mockResolvedValueOnce({ ...at, state: "ready" });
    const seen: unknown[] = [];
    await tauriSpelling.watch((p) => seen.push(p));
    await tauriSpelling.watchModel((m) => seen.push(m.state));
    expect(seen).toEqual([{ phase: "idle" }, "ready"]);
    expect(vi.mocked(listen).mock.calls.map(([name]) => name)).toEqual(["plugin:spelling:phase-changed", "plugin:spelling:model-changed"]);
  });
});
