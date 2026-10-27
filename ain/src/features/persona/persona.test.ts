// @vitest-environment happy-dom
/**
 * Conversation: the shortcut or the tab's button calls PersonaPlex; the pill says who is speaking,
 * and the tab shows the voice's last words. Where it runs (this computer, where the app installs it, or
 * an AI provider's server), the voice and the persona are set in Settings.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { persona, personaGlance, statusText, talking, voiceName, localSetup, modelSetup, localLine } = await import(".");
const { VOICES } = await import("./voices");
const { bindings } = await import("../../shell/commands");
const { catalogue } = await import("..");
const { memoryProviders } = await import("../../shell/providers");
import type { AiProvider } from "../../shell/providers";
import type { LocalInfo, Phase, PersonaPort } from "./service";
import { type Problem, onProblem } from "../../sdk/report";

/** Collects the problems reported until `stop`, keeping them off the console. */
const problems = () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const list: Problem[] = [];
  const stop = onProblem((p) => list.push(p));
  return { list, stop: () => (stop(), vi.mocked(console.warn).mockRestore()) };
};

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
    test: vi.fn(async (_onProgress: (line: string) => void) => 8998),
    stopTest: vi.fn(async () => {}),
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

  it("shows PersonaPlex's download on its card, until it is ready", async () => {
    const { local, root, host } = mount();
    await new Promise((r) => setTimeout(r));
    const card = root.querySelector<HTMLElement>(".dict-model")!;
    expect([card.hidden, card.textContent]).toEqual([false, "PersonaPlexNot installedSet up in Settings"]);
    local({ dir: "/m/personaplex", running: false, model: { state: "downloading", received: 8.5e9, total: 17e9 }, state: "ready" });
    const bar = card.querySelector<HTMLElement>(".bar")!;
    expect([card.textContent?.includes("Downloading… 8.5 GB of 17.0 GB"), bar.hidden, bar.style.getPropertyValue("--p")]).toEqual([true, false, "0.5"]);
    card.querySelector<HTMLButtonElement>(".chip")!.click();
    expect(host.openSettings).toHaveBeenCalled();
    local({ dir: "/m/personaplex", running: false, model: { state: "ready" }, state: "ready" });
    expect(card.hidden).toBe(true);
  });

  it("shows no card while an AI provider's server talks instead", async () => {
    const { local, root, host } = mount();
    host.options = () => ({ engine: "gpu" }) as never;
    local({ dir: "/m/personaplex", running: false, model: { state: "missing" }, state: "missing" });
    expect(root.querySelector<HTMLElement>(".dict-model")!.hidden).toBe(true);
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
    expect(localSetup({ ...at, state: "installing", line: "Installing PyTorch for NVIDIA GPUs (about 2.5 GB)… 3:07" }).detail).toBe(
      "Installing PyTorch for NVIDIA GPUs (about 2.5 GB)… 3:07",
    );
    expect(localSetup({ ...at, state: "ready" })).toMatchObject({ action: "remove", label: "Remove" });
    expect(localSetup({ ...at, state: "ready" }).detail).toContain("10 minutes");
    expect(localSetup({ ...at, running: true, state: "ready" }).detail).toBe("Installed, running now");
    expect(localSetup({ ...at, state: "error", message: "uv failed" })).toEqual({ detail: "Install failed: uv failed", action: "install", label: "Retry" });
  });

  it("offers to download the model once installed, until it is there", () => {
    const at = { dir: "/m", running: false };
    expect(modelSetup({ ...at, model: { state: "missing" }, state: "missing" })).toBeNull();
    expect(modelSetup({ ...at, model: { state: "missing" }, state: "ready" })).toMatchObject({ action: "download", label: "Download · 17 GB", progress: null });
    expect(modelSetup({ ...at, model: { state: "missing" }, state: "ready" })?.detail).toContain("Hugging Face token");
    expect(modelSetup({ ...at, model: { state: "downloading", received: 0, total: 0 }, state: "ready" })).toEqual({ detail: "Downloading…", action: "stop", label: "Stop", progress: 0 });
    const halfway = modelSetup({ ...at, model: { state: "downloading", received: 6.9e9, total: 16.7e9 }, state: "ready" });
    expect(halfway?.detail).toBe("Downloading… 6.9 GB of 16.7 GB");
    expect(halfway?.progress).toBeCloseTo(0.413, 3);
    expect(modelSetup({ ...at, model: { state: "error", message: "403 gated" }, state: "ready" })).toEqual({ detail: "Download failed: 403 gated", action: "download", label: "Retry", progress: null });
    expect(modelSetup({ ...at, model: { state: "ready" }, state: "ready" })).toBeNull();
  });

  it("shows on the island what PersonaPlex lacks, and how far it is, until it is ready", () => {
    const at = { dir: "/m", running: false };
    expect(localLine({ ...at, model: { state: "missing" }, state: "missing" })).toMatchObject({ title: "PersonaPlex", detail: "Not installed", state: "missing", progress: null });
    expect(localLine({ ...at, model: { state: "missing" }, state: "installing", line: "Resolved 40 packages" })).toMatchObject({ detail: "Installing…", state: "downloading" });
    expect(localLine({ ...at, model: { state: "missing" }, state: "ready" })).toMatchObject({ detail: "Model not downloaded yet", state: "missing" });
    expect(localLine({ ...at, model: { state: "missing" }, state: "error", message: "uv failed" })).toMatchObject({ detail: "Install failed: uv failed", state: "error" });
    expect(localLine({ ...at, model: { state: "downloading", received: 4e9, total: 16e9 }, state: "ready" })).toEqual({
      title: "PersonaPlex",
      detail: "Downloading… 4.0 GB of 16.0 GB",
      progress: 0.25,
      state: "downloading",
      dir: "/m",
      received: 4e9,
    });
    expect(localLine({ ...at, model: { state: "error", message: "403 gated" }, state: "ready" })).toMatchObject({ detail: "Download failed: 403 gated", state: "error" });
    expect(localLine({ ...at, model: { state: "ready" }, state: "ready" })).toBeNull();
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
    const action = () => buttons()[2]!;
    return { ...fake, root, host, models, cleanup, localRow, action, folder: buttons()[0]!, test: () => buttons()[1]!, model: () => buttons()[3]! };
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

  it("downloads the model once installed, and stops the download", async () => {
    const { port, local, localRow, action, model } = mount("", { dir: "/m/personaplex", running: false, model: { state: "missing" }, state: "ready" });
    await tick();
    const bar = localRow.querySelector<HTMLElement>(".progress")!;
    expect([model().hidden, model().textContent, action().hidden, bar.hidden]).toEqual([false, "Download · 17 GB", false, true]);
    expect(localRow.textContent).toContain("isn't downloaded yet");
    model().click();
    expect(port.download).toHaveBeenCalledOnce();
    local({ dir: "/m/personaplex", running: false, model: { state: "downloading", received: 6.8e9, total: 17e9 }, state: "ready" });
    expect(localRow.textContent).toContain("Downloading… 6.8 GB of 17.0 GB");
    expect([model().textContent, action().hidden, bar.hidden, bar.style.getPropertyValue("--p")]).toEqual(["Stop", true, false, "0.4"]);
    // Two seconds and 72 MB later: 36 MB/s.
    vi.spyOn(Date, "now").mockReturnValueOnce(Date.now() + 2000);
    local({ dir: "/m/personaplex", running: false, model: { state: "downloading", received: 6.8e9 + 72e6, total: 17e9 }, state: "ready" });
    expect(localRow.textContent).toMatch(/Downloading… 6\.9 GB of 17\.0 GB · 3\d\.\d MB\/s/);
    model().click();
    expect(port.cancelDownload).toHaveBeenCalledOnce();
    port.download.mockRejectedValueOnce("worker gone");
    local({ dir: "/m/personaplex", running: false, model: { state: "error", message: "403 gated" }, state: "ready" });
    expect([model().textContent, action().hidden, bar.hidden]).toEqual(["Retry", false, true]);
    const seen = problems();
    model().click();
    await tick();
    expect(seen.list).toEqual([{ title: "Couldn't download PersonaPlex's model", message: "worker gone", code: "PERSONA_MODEL" }]);
    seen.stop();
  });

  it("tests the server, with its progress, then says it answered", async () => {
    const { port, test, localRow } = mount("", { dir: "/m/personaplex", running: false, model: { state: "ready" }, state: "ready" });
    await tick();
    let progress: (line: string) => void = () => {};
    let answer: (port: number) => void = () => {};
    port.test.mockImplementationOnce((onProgress) => ((progress = onProgress), new Promise((r) => (answer = r))));
    expect([test().hidden, test().textContent]).toEqual([false, "Test"]);
    test().click();
    const result = () => localRow.querySelector<HTMLElement>(".test-result")!;
    expect([result().textContent, test().textContent]).toEqual(["Starting PersonaPlex…", "Stop test"]);
    progress("Loading the model");
    expect(result().textContent).toBe("Starting PersonaPlex… Loading the model");
    answer(41234);
    await tick();
    expect([result().textContent, result().dataset.state, test().textContent]).toEqual([
      "Running: PersonaPlex answered on port 41234. It stops after 10 minutes unused.",
      "ok",
      "Test",
    ]);
  });

  it("says why the server didn't start, and stops a test when asked", async () => {
    const { port, test, localRow } = mount("", { dir: "/m/personaplex", running: false, model: { state: "ready" }, state: "ready" });
    await tick();
    const seen = problems();
    const why = "PersonaPlex stopped (exit code: 1):\nTraceback (most recent call last):\nRuntimeError: CUDA out of memory";
    port.test.mockRejectedValueOnce(why);
    test().click();
    await tick();
    const result = () => localRow.querySelector<HTMLElement>(".test-result")!;
    expect([result().textContent, result().dataset.state]).toEqual(["It didn't start: the notification says why.", "error"]);
    expect(seen.list).toEqual([
      { title: "PersonaPlex didn't start", message: why, code: "PERSONA_TEST" },
    ]);

    let fail: (e: unknown) => void = () => {};
    port.test.mockImplementationOnce(() => new Promise((_, no) => (fail = no)));
    test().click();
    test().click();
    expect(port.stopTest).toHaveBeenCalledOnce();
    fail("cancelled");
    await tick();
    expect(result().textContent).toBe("Test stopped.");
    expect(seen.list).toHaveLength(1);
    seen.stop();
  });

  it("offers a test only once installed, and not while the model downloads", async () => {
    const { local, test } = mount();
    await tick();
    expect(test().hidden).toBe(true);
    local({ dir: "/m/personaplex", running: false, model: { state: "downloading", received: 1, total: 2 }, state: "ready" });
    expect(test().hidden).toBe(true);
    local({ dir: "/m/personaplex", running: false, model: { state: "missing" }, state: "ready" });
    expect(test().hidden).toBe(false);
  });

  it("says why an install couldn't start", async () => {
    const { port, action, folder, localRow } = mount();
    await tick();
    port.install.mockRejectedValueOnce("uv isn't installed");
    port.openFolder.mockRejectedValueOnce(new Error("no folder"));
    const seen = problems();
    action().click();
    folder.click();
    await tick();
    expect(seen.list.map((p) => `[${p.code}] ${p.title}: ${p.message}`)).toEqual([
      "[PERSONA_SETUP] Couldn't install PersonaPlex: uv isn't installed",
      "[FOLDER_OPEN] Couldn't open PersonaPlex's folder: no folder",
    ]);
    expect(localRow.textContent).toContain("Not installed");
    seen.stop();
  });

  it("closes cleanly when the backend can't be followed", async () => {
    const fake = fakePort();
    fake.port.watchLocal.mockRejectedValueOnce(new Error("gone"));
    const host = { options: () => ({ engine: "", remoteModel: "" }), setOptions: vi.fn(), openPage: vi.fn() };
    const root = document.createElement("div");
    const seen = problems();
    const cleanup = persona.settingsPanel?.(root, { persona: fake.port, providers: memoryProviders([]) } as never, host as never) as () => void;
    await tick();
    const row = [...root.querySelectorAll<HTMLElement>(".field")].find((f) => f.textContent?.startsWith("PersonaPlex"))!;
    expect(row.textContent).toContain("Its state can't be read right now.");
    expect(seen.list).toEqual([{ title: "Couldn't check PersonaPlex on this computer", message: "gone", code: "PERSONA_STATE" }]);
    seen.stop();
    expect([...row.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent)).toEqual(["Show folder"]);
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

describe("when the backend refuses", () => {
  const tick = () => new Promise((r) => setTimeout(r));
  const installed: LocalInfo = { dir: "/m/personaplex", running: false, model: { state: "ready" }, state: "ready" };
  const settings = (info: LocalInfo) => {
    const fake = fakePort(info);
    const root = document.createElement("div");
    const host = { options: () => ({ engine: "", remoteModel: "" }), setOptions: vi.fn(), openPage: vi.fn() };
    persona.settingsPanel?.(root, { persona: fake.port, providers: memoryProviders([]) } as never, host as never);
    const row = [...root.querySelectorAll<HTMLElement>(".field")].find((f) => f.textContent?.startsWith("PersonaPlex"))!;
    return { ...fake, row, button: (label: string) => [...row.querySelectorAll("button")].find((b) => b.textContent === label)! };
  };

  it("says why PersonaPlex couldn't be removed, a download stopped, or a test stopped", async () => {
    const seen = problems();
    const { port, local, button } = settings(installed);
    await tick();
    port.remove.mockRejectedValueOnce(new Error("in use"));
    button("Remove").click();
    local({ ...installed, model: { state: "downloading", received: 1, total: 2 } });
    port.cancelDownload.mockRejectedValueOnce(new Error("gone"));
    button("Stop").click();
    local(installed);
    port.test.mockImplementationOnce(() => new Promise(() => {}));
    port.stopTest.mockRejectedValueOnce(new Error("no server"));
    button("Test").click();
    button("Stop test").click();
    await tick();
    expect(seen.list.map((p) => `[${p.code}] ${p.title}: ${p.message}`)).toEqual([
      "[PERSONA_SETUP] Couldn't remove PersonaPlex: in use",
      "[PERSONA_MODEL] Couldn't stop the download: gone",
      "[PERSONA_TEST] Couldn't stop the test: no server",
    ]);
    seen.stop();
  });

  it("keeps the island's tab working when PersonaPlex's state can't be read", async () => {
    const fake = fakePort();
    fake.port.watchLocal.mockRejectedValueOnce(new Error("gone"));
    const host = { refresh: vi.fn(), options: () => ({}) as never, setOptions: vi.fn(), secret: async () => "", openSettings: vi.fn(), openPage: vi.fn(), appearance: () => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }) as const };
    const widget = persona.setup({ persona: fake.port } as never, host);
    const root = document.createElement("section");
    widget.panel?.(root);
    await tick();
    expect(root.querySelector<HTMLElement>(".dict-model")?.hidden).toBe(true);
    expect(root.querySelector(".dict-main")).not.toBeNull();
  });
});
