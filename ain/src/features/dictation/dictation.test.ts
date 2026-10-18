// @vitest-environment happy-dom
/**
 * Where dictation is set up: the speech model is chosen, downloaded and stored in Settings, and the
 * island only dictates (and points to Settings when the model isn't ready).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { dictation } = await import(".");
import type { DictationPort, ModelInfo } from "./service";

const at = { model: "whisper-small", dir: "D:/Models/whisper-small-int8", installed: [] };

/** A dictation backend whose model status can be pushed by the test. */
function fakePort() {
  let push: (info: ModelInfo) => void = () => {};
  const stop = vi.fn();
  const port = {
    watch: vi.fn(async (onChange: (p: never) => void) => (onChange({ phase: "idle" } as never), () => {})),
    watchModel: vi.fn(async (onChange: (info: ModelInfo) => void) => {
      push = onChange;
      return stop;
    }),
    openFolder: vi.fn(async () => {}),
    microphones: vi.fn(async () => [
      { id: "wasapi:{a}", name: "Headset" },
      { id: "wasapi:{b}", name: "Webcam mic" },
    ]),
    control: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  } satisfies DictationPort;
  return { port, stop, model: (info: ModelInfo) => push(info) };
}

const tick = () => new Promise((r) => setTimeout(r));
const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")];
const named = (root: HTMLElement, text: string) => buttons(root).find((b) => b.textContent === text);

describe("in the island", () => {
  const mount = () => {
    const { port, model } = fakePort();
    const host = { refresh() {}, options: () => ({}) as never, setOptions: vi.fn(), secret: async () => "", openSettings: vi.fn(), appearance: () => ({ style: "pill", size: "normal", theme: "island", tone: "dark", notch: false }) as const };
    const widget = dictation.setup({ dictation: port, clipboard: { copy: vi.fn() } } as never, host);
    const root = document.createElement("section");
    widget.panel?.(root);
    return { root, host, port, model };
  };

  it("offers no way to pick a model or a folder", async () => {
    const { root, model } = mount();
    model({ ...at, state: "missing", size: 375e6 });
    await tick();
    const labels = buttons(root).map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(labels).toEqual(["Start dictating", "Copy", "Set up in Settings"]);
    expect(root.querySelector("select, input")).toBeNull();
  });

  it("sends the user to this widget's settings to set the model up", async () => {
    const { root, host, port, model } = mount();
    model({ ...at, state: "missing", size: 375e6 });
    await tick();
    named(root, "Set up in Settings")?.click();
    expect(host.openSettings).toHaveBeenCalledOnce();
    expect(port.download).not.toHaveBeenCalled();
    expect(host.setOptions).not.toHaveBeenCalled();
  });

  it("only shows the model once it is ready", async () => {
    const { root, model } = mount();
    model({ ...at, state: "ready" });
    await tick();
    expect(named(root, "Set up in Settings")?.hidden).toBe(true);
    expect(root.querySelector(".dict-model")?.textContent).toContain("Whisper small");
    expect(root.querySelector<HTMLButtonElement>(".dict-main")?.disabled).toBe(false);
  });
});

describe("in Settings", () => {
  const mount = () => {
    const { port, stop, model } = fakePort();
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    let microphone = "";
    const host = { options: () => ({ model: "whisper-small", microphone }) as never, setOptions: vi.fn() };
    const useMic = (id: string) => (microphone = id);
    const cleanup = dictation.settingsPanel?.(root, { dictation: port } as never, host);
    return { root, port, stop, model, cleanup, host, useMic };
  };

  it("lists the models in a drop-down, marking the downloaded ones", async () => {
    const { root, model } = mount();
    await tick();
    model({ ...at, installed: ["parakeet-v3", "whisper-small"], state: "ready" });
    const trigger = root.querySelectorAll<HTMLElement>(".ui-select")[1]!.querySelector<HTMLButtonElement>(".ui-select-trigger")!;
    expect(trigger.textContent).toContain("Whisper small");
    trigger.click();
    const downloaded = [...root.querySelectorAll("[role=option]")].filter((o) => o.textContent?.includes("Downloaded")).map((o) => o.querySelector(".ui-select-label")?.firstChild?.textContent);
    expect(downloaded).toEqual(["Parakeet TDT v3", "Whisper small"]);
  });

  it("lists the microphones, the system's default first, and saves the one picked", async () => {
    const { root, host } = mount();
    await tick();
    const [mics] = root.querySelectorAll<HTMLElement>(".ui-select");
    mics!.querySelector<HTMLButtonElement>(".ui-select-trigger")!.click();
    const names = [...mics!.querySelectorAll("[role=option] .ui-select-label")].map((o) => o.textContent);
    expect(names).toEqual(["System default", "Headset", "Webcam mic"]);
    mics!.querySelectorAll<HTMLElement>("[role=option]")[2]?.click();
    expect(host.setOptions).toHaveBeenCalledWith({ microphone: "wasapi:{b}" });
  });

  it("keeps showing a chosen microphone that is unplugged", async () => {
    const { port, root, useMic } = mount();
    useMic("wasapi:{gone}");
    window.dispatchEvent(new Event("focus"));
    await tick();
    expect(port.microphones).toHaveBeenCalledTimes(2);
    expect(root.querySelector(".ui-select-trigger")?.textContent).toContain("Disconnected microphone");
  });

  it("saves the model picked in the list as the option", async () => {
    const { root, host } = mount();
    const models = root.querySelectorAll<HTMLElement>(".ui-select")[1]!;
    models.querySelector<HTMLButtonElement>(".ui-select-trigger")!.click();
    const parakeet = [...root.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent?.startsWith("Parakeet TDT v3"));
    parakeet?.click();
    expect(host.setOptions).toHaveBeenCalledWith({ model: "parakeet-v3" });
  });

  it("downloads a missing model, stops a download, removes a downloaded one", async () => {
    const { root, port, model } = mount();
    await tick();
    model({ ...at, state: "missing", size: 375e6 });
    named(root, "Download · 375 MB")?.click();
    expect(port.download).toHaveBeenCalledOnce();

    model({ ...at, state: "downloading", received: 1, total: 4 });
    expect(root.querySelector<HTMLElement>(".progress")?.style.getPropertyValue("--p")).toBe("0.25");
    named(root, "Stop")?.click();
    model({ ...at, state: "ready" });
    named(root, "Remove")?.click();
    expect(port.remove).toHaveBeenCalledTimes(2);
    expect(root.querySelector(".field-hint")?.getAttribute("title")).toBe("D:/Models/whisper-small-int8");
  });

  it("shows the model folder", async () => {
    const { root, port } = mount();
    named(root, "Show folder")?.click();
    expect(port.openFolder).toHaveBeenCalledOnce();
  });

  it("stops watching the model and the window when the card goes away", async () => {
    const { stop, cleanup, port } = mount();
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    await tick();
    expect(stop).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("focus"));
    expect(port.microphones).toHaveBeenCalledOnce();
  });
});

describe("its settings", () => {
  it("keep the model choice and folder as options of the Settings card", () => {
    expect(dictation.options?.model.kind).toBe("choice");
    expect(dictation.options?.model.inPanel).toBe(true);
    expect(dictation.options?.microphone.inPanel).toBe(true);
    expect(dictation.options?.microphone.default).toBe("");
    expect(dictation.options?.modelDir.kind).toBe("folder");
  });
});
