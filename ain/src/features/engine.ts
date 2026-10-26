/**
 * What an AI feature runs on: its own model on this computer, or a model of one of the AI providers
 * set up in Settings → AI providers. The feature's "engine" option holds the provider's id ("" for
 * its own model), "remoteModel" the provider's model, and for read aloud "remoteVoice" its voice.
 */
import { h } from "../sdk/dom";
import { text } from "../sdk/options";
import type { SettingsHost } from "../sdk/plugin";
import { type SelectOption, select } from "../sdk/select";
import { type AiProvider, type Capability, type ProvidersPort, presetById, suggestions } from "../shell/providers";
import { fieldRow as row } from "./model-files";

/** The engine options every AI feature has; drawn by `enginePanel`. */
export const engineOptions = () => ({
  engine: { ...text("Engine"), inPanel: true },
  remoteModel: { ...text("Provider model"), inPanel: true },
});

/** Read aloud's voice, among the provider's. */
export const voiceOption = () => ({ ...text("Provider voice"), inPanel: true });

export interface EngineValues {
  readonly engine: string;
  readonly remoteModel: string;
  readonly remoteVoice?: string;
}

/** The engines to choose from: this computer first, then the providers, and the chosen one even if it was removed. */
export function engineChoices(providers: readonly AiProvider[], chosen: string): SelectOption[] {
  const known = !chosen || providers.some((p) => p.id === chosen);
  return [
    { value: "", label: "On this computer", detail: "The model downloaded below; nothing leaves the computer" },
    ...providers.map((p) => ({ value: p.id, label: p.name, detail: p.baseUrl, badge: presetById(p.preset).id === "custom" ? "Custom" : undefined })),
    ...(known ? [] : [{ value: chosen, label: "Removed provider", detail: "Choose another, or add it again in AI providers" }]),
  ];
}

/** What runs the feature, in a few words; null on this computer. */
export function remoteName(providers: readonly AiProvider[], options: EngineValues): string | null {
  if (!options.engine) return null;
  const provider = providers.find((p) => p.id === options.engine);
  return `${provider?.name ?? "Removed provider"} · ${options.remoteModel || "no model chosen"}`;
}

let lists = 0;

/** A text box offering `options` as it is typed in, saved on change. */
function suggestBox(value: string, label: string, placeholder: string, onChange: (v: string) => void) {
  const id = `engine-suggest-${++lists}`;
  const list = h("datalist", { id });
  const input = h("input", { class: "path-input", type: "text", spellcheck: "false", placeholder, list: id, "aria-label": label });
  input.value = value;
  input.addEventListener("change", () => onChange((input.value = input.value.trim())));
  const offer = (options: readonly string[]) => list.replaceChildren(...options.map((o) => h("option", { value: o })));
  return { el: h("div", {}, input, list), input, offer };
}

/**
 * Settings' engine picker for a feature's card: this computer or a provider, then the provider's
 * model (and voice). `onLocal` tells the card whether its own model's controls apply.
 */
export function enginePanel(
  port: ProvidersPort,
  host: SettingsHost<EngineValues>,
  capability: Capability,
  onLocal: (local: boolean) => void,
): { readonly el: HTMLElement; stop(): void } {
  let providers: readonly AiProvider[] = [];
  const chosen = () => providers.find((p) => p.id === host.options().engine);
  const model = suggestBox(host.options().remoteModel, "Provider model", capability === "stt" ? "whisper-1" : "tts-1", (v) => host.setOptions({ remoteModel: v }));
  const voice = suggestBox(host.options().remoteVoice ?? "", "Provider voice", "The provider's default", (v) => host.setOptions({ remoteVoice: v }));
  const hint = h("p", { class: "field-hint" });
  const picker = select(engineChoices([], host.options().engine), host.options().engine, (id) => {
    const p = providers.find((q) => q.id === id);
    // A new provider starts on its first suggested model (and voice), when it has one.
    const first = (list: readonly string[]) => list[0] ?? "";
    const patch = p ? { engine: id, remoteModel: first(suggestions(p, capability)), ...(capability === "tts" ? { remoteVoice: first(presetById(p.preset).voices) } : {}) } : { engine: id };
    host.setOptions(patch);
    if ("remoteModel" in patch) model.input.value = patch.remoteModel;
    if ("remoteVoice" in patch) voice.input.value = patch.remoteVoice;
    paint();
  }, "Engine");
  const modelRow = row("Provider model", model.el);
  const voiceRow = row("Provider voice", voice.el);
  const el = h("div", { class: "engine" }, row("Engine", picker.el), hint, modelRow, voiceRow);

  /** The models the provider lists, offered alongside the preset's once they arrive. */
  let asked = "";
  const list = (p: AiProvider) => {
    if (asked === p.id) return;
    asked = p.id;
    port.models(p).then((listed) => asked === p.id && model.offer(suggestions(p, capability, listed)), () => {});
  };

  const paint = () => {
    const p = chosen();
    const local = !host.options().engine;
    modelRow.hidden = local;
    voiceRow.hidden = local || capability !== "tts";
    hint.textContent = local
      ? providers.length
        ? ""
        : "To use an online service or your own server instead, add it in Settings → AI providers."
      : p
        ? `Sent to ${p.baseUrl}`
        : "This provider was removed: choose another engine.";
    hint.hidden = !hint.textContent;
    if (p) {
      model.offer(suggestions(p, capability));
      voice.offer(presetById(p.preset).voices);
      list(p);
    }
    onLocal(local);
  };

  const watching = port.watch((next) => {
    providers = next;
    picker.setOptions(engineChoices(providers, host.options().engine));
    picker.set(host.options().engine);
    paint();
  });
  paint();
  return { el, stop: () => void watching.then((stop) => stop(), () => {}) };
}
