// @vitest-environment happy-dom
/** The model rows shared by dictation and read aloud: Settings' "Model files" row and the island's card. */
import { describe, expect, it, vi } from "vitest";
import { type ModelInfo, downloading, modelCard, modelFiles, modelLine, progressOf, size } from "./model-files";

const at = { model: "m", dir: "D:/Models/m", installed: [] };
const tick = () => new Promise((r) => setTimeout(r));
const named = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text);

describe("the island's model line", () => {
  it("says why a download failed", () =>
    expect(modelLine("Whisper", { state: "error", message: "offline" })).toEqual({ title: "Whisper", detail: "Download failed: offline", progress: null }));
});

describe("the model files row", () => {
  const mount = () => {
    const port = { download: vi.fn(async () => {}), remove: vi.fn(async () => {}), openFolder: vi.fn(async () => {}) };
    const files = modelFiles(port);
    return { port, files, el: files.el, action: files.el.querySelector<HTMLButtonElement>(".recorder button:last-child")! };
  };

  it("does nothing until it knows the model's state", () => {
    const { port, action } = mount();
    action.click();
    expect([port.download.mock.calls.length, port.remove.mock.calls.length]).toEqual([0, 0]);
  });

  it("shows why downloading or removing failed", async () => {
    const { port, files, el, action } = mount();
    port.download.mockRejectedValueOnce("disk full");
    files.draw({ ...at, state: "error", message: "offline" } as ModelInfo);
    expect(action.textContent).toBe("Retry");
    action.click();
    await tick();
    expect(el.querySelector(".field-hint")?.textContent).toBe("disk full");
    port.remove.mockRejectedValueOnce(new Error("in use"));
    files.draw({ ...at, state: "ready" } as ModelInfo);
    expect(action.classList.contains("danger")).toBe(true);
    action.click();
    await tick();
    expect(el.querySelector(".field-hint")?.textContent).toBe("Error: in use");
  });

  it("stays put when the folder can't be shown", async () => {
    const { port, el } = mount();
    port.openFolder.mockRejectedValueOnce(new Error("no file manager"));
    named(el, "Show folder")?.click();
    await tick();
    expect(port.openFolder).toHaveBeenCalledOnce();
    expect(el.querySelector(".field-hint")?.textContent).toBe("");
  });
});

describe("the island's model card", () => {
  it("points to Settings, where a download in progress can be stopped", () => {
    const openSettings = vi.fn();
    const card = modelCard(openSettings);
    card.draw("Whisper", { ...at, state: "downloading", received: 1, total: 2 } as ModelInfo);
    const setUp = card.el.querySelector<HTMLButtonElement>("button")!;
    expect([setUp.hidden, setUp.textContent, card.el.dataset.state]).toEqual([false, "Settings", "downloading"]);
    expect(card.el.querySelector<HTMLElement>(".bar")?.style.getPropertyValue("--p")).toBe("0.5");
    setUp.click();
    expect(openSettings).toHaveBeenCalledOnce();
  });
});

describe("download sizes", () => {
  it("are in MB, then GB from 1 GB on", () => {
    expect([size(0), size(670e6), size(999e6), size(1e9), size(16.7e9)]).toEqual(["0 MB", "670 MB", "999 MB", "1.0 GB", "16.7 GB"]);
  });

  it("say how far a download is once its total is known", () => {
    expect([downloading(0, 0), downloading(335e6, 670e6), downloading(6.9e9, 16.7e9)]).toEqual(["Downloading…", "Downloading… 335 MB of 670 MB", "Downloading… 6.9 GB of 16.7 GB"]);
    expect([progressOf(5, 0), progressOf(1, 4), progressOf(9, 4)]).toEqual([0, 0.25, 1]);
  });
});
