/**
 * AI providers: what the settings keep of each, what's wrong with one, the presets new ones start
 * from, and the models suggested for each AI feature.
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => ["whisper-1"]));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { PRESETS, builtInPresets, memoryProviders, newProvider, parseProviders, presetById, presetsAt, providerProblem, settingsProviders, suggestions, tauriPresets } = await import("./providers");
import type { AiProvider } from "./providers";

const openai: AiProvider = { id: "openai", name: "OpenAI", preset: "openai", baseUrl: "https://api.openai.com/v1", auth: { kind: "env", name: "OPENAI_API_KEY" } };
const lab: AiProvider = { id: "lab", name: "Lab", preset: "custom", baseUrl: "http://10.0.0.2:8000/v1", auth: { kind: "file", path: "/run/secrets/jwt" } };

describe("stored providers", () => {
  it("keep every valid one, once, and the defaults of what doesn't read", () => {
    const raw = [openai, lab, { ...lab, name: "Again" }, { id: "Bad id", name: "x", baseUrl: "" }, "nope", { id: "odd", name: "Odd", preset: "gone", baseUrl: "x", auth: { kind: "magic" } }];
    expect(parseProviders(raw)).toEqual([openai, lab, { id: "odd", name: "Odd", preset: "custom", baseUrl: "x", auth: { kind: "none" } }]);
    expect(parseProviders({ openai })).toEqual([]);
    expect(parseProviders(undefined)).toEqual([]);
  });
});

describe("a provider", () => {
  it("needs a web address, and somewhere to read its token from", () => {
    expect(providerProblem(openai)).toBeNull();
    expect(providerProblem(lab)).toBeNull();
    expect(providerProblem({ ...lab, auth: { kind: "none" } })).toBeNull();
    expect(providerProblem({ ...lab, baseUrl: "ftp://host" })).toMatch(/^The address/);
    expect(providerProblem({ ...openai, auth: { kind: "env", name: "1BAD" } })).toMatch(/environment variable/);
    expect(providerProblem({ ...lab, auth: { kind: "file", path: " " } })).toMatch(/file/);
  });

  it("starts from a preset, under an id of its own", () => {
    expect(newProvider(presetById("openai"), [])).toEqual(openai);
    expect(newProvider(presetById("openai"), ["openai", "openai-2"])).toMatchObject({ id: "openai-3", name: "OpenAI 3" });
    expect(newProvider(presetById("custom"), [])).toMatchObject({ id: "custom", auth: { kind: "none" }, baseUrl: "http://localhost:8000/v1" });
    expect(presetById("gone")).toBe(PRESETS[PRESETS.length - 1]);
  });

  it("starts from the presets at their overridden addresses", async () => {
    const presets = presetsAt({ openai: "https://gw.example/v1" });
    expect(presets.map((p) => p.baseUrl)).toEqual(["https://gw.example/v1", ...PRESETS.slice(1).map((p) => p.baseUrl)]);
    expect(newProvider(presetById("openai", presets), [])).toEqual({ ...openai, baseUrl: "https://gw.example/v1" });
    expect(await builtInPresets()).toBe(PRESETS);
    invoke.mockResolvedValueOnce({ openai: "a", groq: "b", mistral: "c", custom: "d" } as never);
    expect((await tauriPresets()).map((p) => p.baseUrl)).toEqual(["a", "b", "c", "d"]);
    expect(invoke).toHaveBeenLastCalledWith("plugin:providers|preset_urls");
    invoke.mockRejectedValueOnce(new Error("old backend"));
    expect(await tauriPresets()).toBe(PRESETS);
  });

  it("suggests its preset's models first, then those it lists", () => {
    expect(suggestions(openai, "stt", ["whisper-1", "gpt-4o"])).toEqual(["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1", "gpt-4o"]);
    expect(suggestions(lab, "tts")).toEqual([]);
    expect(suggestions(undefined, "tts", ["x"])).toEqual([]);
  });
});

describe("the providers port", () => {
  it("follows the providers in the settings, and asks the backend for models", async () => {
    let push: (raw: unknown) => void = () => {};
    const port = settingsProviders(async (onChange) => ((push = onChange), () => {}));
    const seen: unknown[] = [];
    await port.watch((list) => seen.push(list));
    push({ providers: [openai] });
    push(null);
    expect(seen).toEqual([[openai], []]);
    expect(await port.models(openai)).toEqual(["whisper-1"]);
    expect(invoke).toHaveBeenCalledWith("plugin:providers|models", { provider: openai });
  });

  it("can be fixed, for previews and tests", async () => {
    const port = memoryProviders([lab], ["m"]);
    const seen: unknown[] = [];
    const stop = await port.watch((list) => seen.push(list));
    stop();
    expect([seen, await port.models(lab)]).toEqual([[[lab]], ["m"]]);
    expect(await memoryProviders().models(lab)).toEqual([]);
  });
});
