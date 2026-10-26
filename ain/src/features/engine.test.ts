// @vitest-environment happy-dom
/**
 * What an AI feature runs on, as its Settings card picks it: this computer, or a provider's model
 * (and voice), with the provider's suggestions and listed models offered as it is typed.
 */
import { describe, expect, it, vi } from "vitest";
import { engineChoices, engineOptions, enginePanel, remoteName, voiceOption } from "./engine";
import { type AiProvider, type ProvidersPort, memoryProviders } from "../shell/providers";
import type { EngineValues } from "./engine";

const openai: AiProvider = { id: "openai", name: "OpenAI", preset: "openai", baseUrl: "https://api.openai.com/v1", auth: { kind: "env", name: "OPENAI_API_KEY" } };
const lab: AiProvider = { id: "lab", name: "Lab", preset: "custom", baseUrl: "http://lab:8000/v1", auth: { kind: "none" } };
const tick = () => new Promise((r) => setTimeout(r));

/** A Settings host whose options follow what is saved. */
function hostWith(start: Partial<EngineValues> = {}) {
  let values: EngineValues = { engine: "", remoteModel: "", remoteVoice: "", ...start };
  const setOptions = vi.fn((patch: Partial<EngineValues>) => void (values = { ...values, ...patch }));
  return { options: () => values, setOptions, openPage: vi.fn() };
}

const mount = (port: ProvidersPort, host = hostWith(), capability: "stt" | "tts" = "tts") => {
  const onLocal = vi.fn();
  const panel = enginePanel(port, host, capability, onLocal);
  document.body.replaceChildren(panel.el);
  const rows = [...panel.el.querySelectorAll<HTMLElement>(".field")];
  const inputs = panel.el.querySelectorAll<HTMLInputElement>("input");
  return { ...panel, host, onLocal, engine: rows[0]!, modelRow: rows[1]!, voiceRow: rows[2]!, model: inputs[0]!, voice: inputs[1]!, hint: panel.el.querySelector<HTMLElement>(".field-hint")! };
};

const choose = (root: HTMLElement, label: string) => {
  root.querySelector<HTMLButtonElement>(".ui-select-trigger")!.click();
  [...root.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent?.startsWith(label))!.click();
};

const offered = (input: HTMLInputElement) => [...document.getElementById(input.getAttribute("list")!)!.querySelectorAll("option")].map((o) => o.value);

describe("the engine options", () => {
  it("are drawn by the feature's panel", () => {
    expect(engineOptions().engine).toMatchObject({ kind: "text", default: "", inPanel: true });
    expect(voiceOption()).toMatchObject({ kind: "text", inPanel: true });
  });

  it("list this computer first, then each provider, and a removed one while it is chosen", () => {
    expect(engineChoices([openai, lab], "").map((c) => [c.value, c.label, c.badge])).toEqual([
      ["", "On this computer", undefined],
      ["openai", "OpenAI", undefined],
      ["lab", "Lab", "Custom"],
    ]);
    expect(engineChoices([], "gone").at(-1)).toMatchObject({ value: "gone", label: "Removed provider" });
  });

  it("name what runs the feature, away from this computer", () => {
    expect(remoteName([openai], { engine: "", remoteModel: "x" })).toBeNull();
    expect(remoteName([openai], { engine: "openai", remoteModel: "tts-1" })).toBe("OpenAI · tts-1");
    expect(remoteName([], { engine: "lab", remoteModel: "" })).toBe("Removed provider · no model chosen");
  });
});

describe("the engine panel", () => {
  it("runs on this computer until a provider is picked, and says where to add one", async () => {
    const { onLocal, modelRow, voiceRow, hint } = mount(memoryProviders());
    await tick();
    expect(onLocal).toHaveBeenLastCalledWith(true);
    expect([modelRow.hidden, voiceRow.hidden]).toEqual([true, true]);
    expect(hint.textContent).toContain("AI providers");
  });

  it("starts a provider on its first suggested model and voice, then offers the models it lists", async () => {
    const { engine, host, onLocal, model, voice, modelRow, voiceRow, hint } = mount(memoryProviders([openai, lab], ["tts-1", "my-tts"]));
    await tick();
    choose(engine, "OpenAI");
    expect(host.setOptions).toHaveBeenLastCalledWith({ engine: "openai", remoteModel: "gpt-4o-mini-tts", remoteVoice: "alloy" });
    expect([model.value, voice.value, modelRow.hidden, voiceRow.hidden]).toEqual(["gpt-4o-mini-tts", "alloy", false, false]);
    expect(onLocal).toHaveBeenLastCalledWith(false);
    expect(hint.textContent).toBe("Sent to https://api.openai.com/v1");
    expect(offered(voice)).toContain("nova");
    await tick();
    expect(offered(model)).toEqual(["gpt-4o-mini-tts", "tts-1", "tts-1-hd", "my-tts"]);
    choose(engine, "Lab");
    expect(host.setOptions).toHaveBeenLastCalledWith({ engine: "lab", remoteModel: "", remoteVoice: "" });
  });

  it("saves the model and voice typed", async () => {
    const { host, model, voice } = mount(memoryProviders([lab]), hostWith({ engine: "lab" }));
    await tick();
    model.value = "  kokoro ";
    model.dispatchEvent(new Event("change"));
    voice.value = "af_bella";
    voice.dispatchEvent(new Event("change"));
    expect(host.setOptions.mock.calls).toEqual([[{ remoteModel: "kokoro" }], [{ remoteVoice: "af_bella" }]]);
    expect(model.value).toBe("kokoro");
  });

  it("asks for speech-to-text models, with no voice", async () => {
    const { voiceRow, model } = mount(memoryProviders([openai]), hostWith({ engine: "openai" }), "stt");
    await tick();
    expect(voiceRow.hidden).toBe(true);
    expect(offered(model)).toContain("whisper-1");
  });

  it("says when the chosen provider was removed", async () => {
    const { hint, engine } = mount(memoryProviders([lab]), hostWith({ engine: "gone", remoteModel: "m" }));
    await tick();
    expect(hint.textContent).toBe("This provider was removed: choose another engine.");
    expect(engine.querySelector(".ui-select-trigger")?.textContent).toContain("Removed provider");
  });

  it("keeps quiet when the provider can't list its models, and back to this computer", async () => {
    const port: ProvidersPort = { watch: memoryProviders([lab]).watch, models: vi.fn(async () => Promise.reject(new Error("offline"))) };
    const { engine, host, model, onLocal } = mount(port, hostWith({ engine: "lab" }));
    await tick();
    expect(port.models).toHaveBeenCalledOnce();
    expect(offered(model)).toEqual([]);
    choose(engine, "On this computer");
    expect(host.setOptions).toHaveBeenLastCalledWith({ engine: "" });
    expect(onLocal).toHaveBeenLastCalledWith(true);
  });

  it("stops following the providers, even when it never could", async () => {
    const stop = vi.fn();
    const { stop: close } = mount({ watch: async () => stop, models: async () => [] });
    close();
    await tick();
    expect(stop).toHaveBeenCalledOnce();
    expect(() => mount({ watch: () => Promise.reject(new Error("gone")), models: async () => [] }).stop()).not.toThrow();
    await tick();
  });
});
