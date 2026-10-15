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
    const host = { refresh() {}, options: () => ({}) as never, setOptions: vi.fn(), openSettings: vi.fn() };
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
    const cleanup = dictation.settingsPanel?.(root, { dictation: port } as never);
    return { root, port, stop, model, cleanup };
  };

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
    expect(root.textContent).toContain("Downloaded, in D:/Models/whisper-small-int8");
  });

  it("shows the model folder", async () => {
    const { root, port } = mount();
    named(root, "Show folder")?.click();
    expect(port.openFolder).toHaveBeenCalledOnce();
  });

  it("stops watching the model when the card goes away", async () => {
    const { stop, cleanup } = mount();
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    await tick();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("its settings", () => {
  it("keep the model choice and folder as options of the Settings card", () => {
    expect(dictation.options?.model.kind).toBe("choice");
    expect(dictation.options?.modelDir.kind).toBe("folder");
    expect(dictation.options?.model.hint).not.toMatch(/island|arrows/i);
  });
});
