// @vitest-environment happy-dom
/**
 * Conversation: the shortcut or the tab's button calls PersonaPlex; the pill says who is speaking,
 * and the tab shows the voice's last words. Where it runs (this computer, where the app installs it, or
 * an AI provider's server), the voice and the persona are set in Settings.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { persona, personaGlance, statusText, talking, voiceName, localSetup, modelSetup } = await import(".");
const { VOICES } = await import("./voices");
const { bindings } = await import("../../shell/commands");
const { catalogue } = await import("..");
const { memoryProviders } = await import("../../shell/providers");
import type { AiProvider } from "../../shell/providers";
import type { LocalInfo, Phase, PersonaPort } from "./service";

const live = (said = "", speaking = false): Phase => ({ phase: "live", level: 0.5, speaking, said });

/** A conversation backend whose phase the test pushes. */
function fakePort(installed: LocalInfo = { dir: "/m/personaplex", running: false, model: { state: "missing" }, state: "missing" }) {
  let push: (phase: Phase) => void = () => {};
  let pushLocal: (info: LocalInfo) => void = () => {};
  const stopLocal = vi.fn();
  const port = {
    watch: vi.fn(async (onChange: (phase: Phase) => void) => ((push = onChange), onChange({ phase: "idle" }), () => {})),
    control: vi.fn(async () => {}),
    watchLocal: vi.fn(async (onChange: (info: LocalInfo) => void) => ((pushLocal = onChange), onChange(installed), stopLocal)),
    install: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    cancelDownload: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    openFolder: vi.fn(async () => {}),
  } satisfies PersonaPort;
  return { port, stopLocal, phase: (p: Phase) => push(p), local: (info: LocalInfo) => pushLocal(info) };
}

describe("on the pill", () => {
  it("says who is speaking, with the user's level while it listens", () => {
    expect(personaGlance({ phase: "starting", line: "" }, 0, 0)).toEqual({ text: "Starting…", mark: "eq", wide: true });
    expect(personaGlance({ phase: "connecting" }, 0, 0)).toEqual({ text: "Connecting…", mark: "eq", wide: true });
    expect(personaGlance(live(), 0, 0)).toEqual({ text: "Listening", mark: "mic", level: 0.5, wide: true });
    expect(personaGlance(live("Hi", true), 0, 0)).toEqual({ text: "Speaking", mark: "eq", wide: true });
    expect(personaGlance({ phase: "idle" }, 0, 0)).toBeNull();
  });

  it("shows a failure while it is fresh", () => {
    expect(personaGlance({ phase: "error", message: "x" }, 1000, 2000)).toEqual({ text: "Conversation failed", tone: "alert" });
    expect(personaGlance({ phase: "error", message: "x" }, 1000, 9000)).toBeNull();
  });

  it("binds its shortcut as an action, with no popup", () => {
    expect(bindings(catalogue, {})["persona.talk"]).toEqual({ shortcut: "Ctrl+Alt+KeyT", surface: "action" });
  });
});

describe("in the island", () => {
  const mount = () => {
    const fake = fakePort();
    const host = { refresh: vi.fn(), options: () => ({}) as never, setOptions: vi.fn(), secret: async () => "", openSettings: vi.fn(), openPage: vi.fn(), appearance: () => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }) as const };
    const widget = persona.setup({ persona: fake.port } as never, host);
    const root = document.createElement("section");
    widget.panel?.(root);
    const main = root.querySelector<HTMLButtonElement>(".dict-main")!;
    const status = root.querySelector<HTMLElement>(".dict-status")!;
    const level = root.querySelector<HTMLElement>(".dict-level")!;
    const settings = [...root.querySelectorAll("button")].find((b) => b.textContent === "Settings")!;
    return { ...fake, root, host, main, status, level, settings, widget };
  };

  it("starts and ends a conversation", () => {
    const { port, phase, main, host } = mount();
    expect(main.getAttribute("aria-label")).toBe("Start talking");
    main.click();
    expect(port.control).toHaveBeenLastCalledWith("toggle");
    phase({ phase: "connecting" });
    expect(main.getAttribute("aria-label")).toBe("End the conversation");
    expect(host.refresh).toHaveBeenCalled();
  });

  it("shows the voice's last words and the user's level", () => {
    const { phase, status, level, settings, widget } = mount();
    expect(level.hidden).toBe(true);
    phase(live("Hello there", true));
    expect([status.textContent, status.classList.contains("dict-quote")]).toEqual(["“Hello there”", true]);
    expect([level.hidden, level.style.getPropertyValue("--p")]).toEqual([false, "0.5"]);
    expect(settings.hidden).toBe(true);
    expect(widget.glance?.(Date.now())?.text).toBe("Speaking");
    phase(live());
    expect(status.textContent).toBe("Listening… say hello.");
  });

  it("says what went wrong, and leads to Settings", () => {
    const { phase, status, settings, host } = mount();
    phase({ phase: "error", message: "Couldn't reach the PersonaPlex server at localhost:8998" });
    expect(status.textContent).toContain("Couldn't reach");
    settings.click();
    expect(host.openSettings).toHaveBeenCalledOnce();
  });

  it("stays put when the backend refuses", async () => {
    const { port, main } = mount();
    port.control.mockRejectedValueOnce(new Error("worker gone"));
    main.click();
    await new Promise((r) => setTimeout(r));
    expect(port.control).toHaveBeenCalledOnce();
  });
});

describe("its settings", () => {
  it("offers PersonaPlex's 18 voices by name", () => {
    expect(VOICES).toHaveLength(18);
    expect(persona.options?.voice.default).toBe("NATF2");
    expect([voiceName("NATF2"), voiceName("VARM0"), voiceName("odd")]).toEqual(["Natural, female 3", "Varied, male 1", "odd"]);
  });

  it("keeps the engine for the panel, and the setup of this computer's PersonaPlex for the form", () => {
    expect(persona.options?.engine).toMatchObject({ kind: "text", default: "", inPanel: true });
    expect(persona.options?.hfToken).toMatchObject({ kind: "secret" });
    expect(persona.options?.cpuOffload).toMatchObject({ kind: "toggle", default: false });
    expect(persona.options?.modelDir).toMatchObject({ kind: "folder", default: "" });
    expect(persona.options).not.toHaveProperty("server");
  });

  it("says what each phase means", () => {
    expect(statusText({ phase: "idle" })).toContain("Ctrl+Alt+T");
    expect(statusText({ phase: "starting", line: "" })).toBe("Starting PersonaPlex…");
    expect(statusText({ phase: "starting", line: "Fetching 4 files: 25%" })).toBe("Starting PersonaPlex… Fetching 4 files: 25%");
    expect(statusText({ phase: "connecting" })).toBe("Connecting to PersonaPlex…");
    expect(talking({ phase: "live", level: 0, speaking: false, said: "" }) && talking({ phase: "starting", line: "" }) && !talking({ phase: "idle" })).toBe(true);
  });

  it("says where PersonaPlex stands on this computer", () => {
    const at = { dir: "/m", running: false, model: { state: "missing" } } as const;
    expect(localSetup({ ...at, state: "missing" })).toMatchObject({ action: "install", label: "Install" });
    expect(localSetup({ ...at, state: "missing" }).detail).toContain("17 GB");
    expect(localSetup({ ...at, state: "installing", line: "" })).toEqual({ detail: "Installing…", action: "remove", label: "Cancel" });
    expect(localSetup({ ...at, state: "installing", line: "Resolved 40 packages" }).detail).toBe("Installing… Resolved 40 packages");
    expect(localSetup({ ...at, state: "ready" })).toMatchObject({ action: "remove", label: "Remove" });
    expect(localSetup({ ...at, state: "ready" }).detail).toContain("10 minutes");
    expect(localSetup({ ...at, running: true, state: "ready" }).detail).toBe("Installed, running now");
    expect(localSetup({ ...at, state: "error", message: "uv failed" })).toEqual({ detail: "Install failed: uv failed", action: "install", label: "Retry" });
  });

  it("offers to download the model once installed, until it is there", () => {
    const at = { dir: "/m", running: false };
    expect(modelSetup({ ...at, model: { state: "missing" }, state: "missing" })).toBeNull();
    expect(modelSetup({ ...at, model: { state: "missing" }, state: "ready" })).toMatchObject({ action: "download", label: "Download model" });
    expect(modelSetup({ ...at, model: { state: "missing" }, state: "ready" })?.detail).toContain("Hugging Face token");
    expect(modelSetup({ ...at, model: { state: "downloading", line: "model.safetensors: 12%" }, state: "ready" })).toEqual({
      detail: "Downloading the model… model.safetensors: 12%",
      action: "cancel",
      label: "Cancel download",
    });
    expect(modelSetup({ ...at, model: { state: "error", message: "403 gated" }, state: "ready" })).toEqual({ detail: "Download failed: 403 gated", action: "download", label: "Retry download" });
    expect(modelSetup({ ...at, model: { state: "ready" }, state: "ready" })).toBeNull();
  });
});

describe("in Settings", () => {
  const gpu: AiProvider = { id: "gpu", name: "GPU box", preset: "custom", baseUrl: "https://gpu.example.com", auth: { kind: "env", name: "PERSONAPLEX_TOKEN" } };
  const tick = () => new Promise((r) => setTimeout(r));

  const mount = (engine = "", installed?: LocalInfo) => {
    let values = { engine, remoteModel: "", voice: "NATF2", prompt: "" };
    const host = { options: () => values, setOptions: vi.fn((patch: Partial<typeof values>) => void (values = { ...values, ...patch })), openPage: vi.fn() };
    const models = vi.fn(async () => []);
    const fake = fakePort(installed);
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const cleanup = persona.settingsPanel?.(root, { persona: fake.port, providers: { ...memoryProviders([gpu]), models } } as never, host as never) as () => void;
    const localRow = [...root.querySelectorAll<HTMLElement>(".field")].find((f) => f.textContent?.startsWith("PersonaPlex"))!;
    const buttons = () => [...localRow.querySelectorAll("button")];
    const action = () => buttons()[1]!;
    return { ...fake, root, host, models, cleanup, localRow, action, folder: buttons()[0]!, model: () => buttons()[2]! };
  };

  it("installs PersonaPlex on this computer, then removes it", async () => {
    const { port, local, localRow, action, folder, model, root, cleanup, stopLocal } = mount();
    await tick();
    expect(localRow.hidden).toBe(false);
    expect(root.querySelector(".ui-select-trigger")?.textContent).toContain("On this computer");
    expect(localRow.textContent).toContain("Not installed");
    action().click();
    expect(port.install).toHaveBeenCalledOnce();
    expect(model().hidden).toBe(true);
    local({ dir: "/m/personaplex", running: false, model: { state: "missing" }, state: "installing", line: "Downloading torch" });
    expect([localRow.textContent?.includes("Installing… Downloading torch"), action().textContent]).toEqual([true, "Cancel"]);
    local({ dir: "/m/personaplex", running: true, model: { state: "ready" }, state: "ready" });
    expect(model().hidden).toBe(true);
    expect([action().textContent, action().classList.contains("danger")]).toEqual(["Remove", true]);
    action().click();
    expect(port.remove).toHaveBeenCalledOnce();
    folder.click();
    expect(port.openFolder).toHaveBeenCalledOnce();
    cleanup();
    await tick();
    expect(stopLocal).toHaveBeenCalledOnce();
  });

  it("downloads the model once installed, and cancels the download", async () => {
    const { port, local, localRow, model } = mount("", { dir: "/m/personaplex", running: false, model: { state: "missing" }, state: "ready" });
    await tick();
    expect([model().hidden, model().textContent]).toEqual([false, "Download model"]);
    expect(localRow.textContent).toContain("isn't downloaded yet");
    model().click();
    expect(port.download).toHaveBeenCalledOnce();
    local({ dir: "/m/personaplex", running: false, model: { state: "downloading", line: "model.safetensors: 40%" }, state: "ready" });
    expect([localRow.textContent?.includes("Downloading the model… model.safetensors: 40%"), model().textContent]).toEqual([true, "Cancel download"]);
    model().click();
    expect(port.cancelDownload).toHaveBeenCalledOnce();
    port.download.mockRejectedValueOnce("worker gone");
    local({ dir: "/m/personaplex", running: false, model: { state: "error", message: "403 gated" }, state: "ready" });
    model().click();
    await tick();
    expect(localRow.textContent).toContain("worker gone");
  });

  it("says why an install couldn't start", async () => {
    const { port, action, folder, localRow } = mount();
    await tick();
    port.install.mockRejectedValueOnce("uv isn't installed");
    port.openFolder.mockRejectedValueOnce(new Error("no folder"));
    action().click();
    folder.click();
    await tick();
    expect(localRow.textContent).toContain("uv isn't installed");
  });

  it("closes cleanly when the backend can't be followed", async () => {
    const fake = fakePort();
    fake.port.watchLocal.mockRejectedValueOnce(new Error("gone"));
    const host = { options: () => ({ engine: "", remoteModel: "" }), setOptions: vi.fn(), openPage: vi.fn() };
    const cleanup = persona.settingsPanel?.(document.createElement("div"), { persona: fake.port, providers: memoryProviders([]) } as never, host as never) as () => void;
    await tick();
    expect(() => cleanup()).not.toThrow();
  });

  it("or talks to an AI provider's server, with no model to pick", async () => {
    const { host, localRow, root, models, cleanup } = mount("", { dir: "/m", running: false, model: { state: "ready" }, state: "ready" });
    await tick();
    root.querySelector<HTMLButtonElement>(".ui-select-trigger")!.click();
    [...root.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent?.startsWith("GPU box"))!.click();
    expect(host.setOptions).toHaveBeenLastCalledWith({ engine: "gpu" });
    expect(localRow.hidden).toBe(true);
    expect(root.textContent).toContain("Sent to https://gpu.example.com");
    expect(models).not.toHaveBeenCalled();
    cleanup();
  });
});
