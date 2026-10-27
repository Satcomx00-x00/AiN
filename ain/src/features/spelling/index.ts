import { button, h } from "../../sdk/dom";
import { choice, folder } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";
import { type SelectOption, select } from "../../sdk/select";
import { keepLoaded, fieldRow as row, modelCard, modelFiles } from "../model-files";
import { type OwnEngine, engineOptions, enginePanel, remoteName } from "../engine";
import type { AiProvider, ProvidersPort } from "../../shell/providers";
import type { Corrector, ModelInfo, Phase, SpellingPort } from "./service";
import { DEFAULT_MODEL, MODELS, modelById } from "./models";

const CHECK = `<path d="M2.5 11.5 5 4.5l2.5 7M3.4 9h3.2"/><path d="m8.5 9.75 2 2 3.5-4.5"/>`;
/** How long a result stays on the pill. */
const SHOW_DONE_MS = 2500;
const SHOW_PROBLEM_MS = 5000;
/** The dictionaries, as the island and Settings name them. */
export const DICTIONARIES = "Dictionaries · French & English";

/** Spelling's own engine: the language model, with the dictionaries as its fallback. */
export const OWN_ENGINE: OwnEngine = { label: "On this computer", detail: "The language model below, or the dictionaries when it can't; nothing leaves the computer" };

/** "1 fix", "3 fixes". */
export const fixes = (n: number): string => `${n} ${n === 1 ? "fix" : "fixes"}`;

/** Who corrected, when it was the fallback: the dictionaries. */
const byLine = (by: Corrector): string => (by === "dictionaries" ? " by the dictionaries" : "");

/** The pill while correcting, then briefly how it went. `since` is when the phase began. */
export function spellingGlance(phase: Phase, since: number, now: number): Glance | null {
  const age = now - since;
  switch (phase.phase) {
    case "checking":
      return { text: "Correcting…", mark: "eq", wide: true };
    case "done":
      if (age >= SHOW_DONE_MS) return null;
      if (!phase.delivery) return { text: "No mistakes", tone: "muted" };
      return { text: phase.delivery === "copied" ? `${fixes(phase.fixes)} · copied` : fixes(phase.fixes), tone: "muted" };
    case "needsModel":
      return age < SHOW_PROBLEM_MS ? { text: "Get a model first", tone: "alert", wide: true } : null;
    case "nothingSelected":
      return age < SHOW_PROBLEM_MS ? { text: "Select text first", tone: "muted" } : null;
    case "error":
      return age < SHOW_PROBLEM_MS ? { text: "Correction failed", tone: "alert" } : null;
    case "idle":
      return null;
  }
}

/** The line in the island's tab. */
export function statusText(phase: Phase): string {
  switch (phase.phase) {
    case "idle":
      return "Select text in any app and press the spelling shortcut (Ctrl+Alt+O) to correct it.";
    case "needsModel":
      return "Download the language model or the dictionaries in Settings, or choose an AI provider, to start correcting.";
    case "nothingSelected":
      return "No text is selected. Select some, then press the shortcut again.";
    case "checking":
      return "Correcting…";
    case "done": {
      if (!phase.delivery) return `No mistakes found${byLine(phase.by)}.`;
      const what = `${fixes(phase.fixes)}${byLine(phase.by)}`;
      return phase.delivery === "copied" ? `${what}, copied: paste it where you want it.` : `${what}, typed over the selection.`;
    }
    case "error":
      return phase.message;
  }
}

/** The language models as Settings lists them: what each is, its size, and whether it's downloaded. */
export const modelOptions = (installed: readonly string[]): SelectOption[] =>
  MODELS.map((m) => ({ value: m.id, label: m.name, detail: m.about, meta: `${m.mb} MB`, badge: installed.includes(m.id) ? "Downloaded" : undefined }));

/** What the island's card shows on this computer: the model, or the dictionaries standing in for it. */
export function localCard(model: ModelInfo, dictionaries: ModelInfo | null): { name: string; info: ModelInfo } {
  const standIn = model.state !== "ready" && model.state !== "downloading" && dictionaries?.state === "ready";
  return standIn ? { name: DICTIONARIES, info: dictionaries } : { name: modelById(model.model).name, info: model };
}

/** Spelling, in French and English, on this computer or by an AI provider: corrects the selected text in place. */
export const spelling = definePlugin({
  id: "spelling",
  label: "Spelling",
  description: "Corrects the selected text, in French or English, on this computer or by an AI provider.",
  icon: CHECK,
  slots: ["glance", "tab"],
  options: {
    // Drawn by the settings panel, which knows the providers and the downloads.
    ...engineOptions(),
    model: { ...choice("Language model", DEFAULT_MODEL, MODELS.map((m) => [m.id, m.name] as const)), inPanel: true },
    language: choice("Language", "auto", [
      ["auto", "Detect"],
      ["fr", "French"],
      ["en", "English"],
    ]),
    apply: choice("Correction", "replace", [
      ["replace", "Replace the selection"],
      ["copy", "Copy it"],
    ], "Replacing types the corrected text over the selection; where typing isn't allowed, it is copied."),
    modelDir: folder("Model folder", "Default folder"),
    keepLoaded: keepLoaded(),
  },
  commands: [
    {
      id: "fix",
      label: "Correct spelling",
      description: "Corrects the selected text in French or English.",
      shortcut: "Ctrl+Alt+KeyO",
      surface: "action",
    },
  ],
  // Choosing the engine and the model, downloading them, and trying a correction happen here in Settings.
  settingsPanel(root, { spelling: port, providers }: { spelling: SpellingPort; providers: ProvidersPort }, host) {
    const picker = select(modelOptions([]), host.options().model, (id) => host.setOptions({ model: id }), "Language model");
    const modelRow = row("Language model", picker.el);
    const files = modelFiles(port);
    const dictionaries = modelFiles(port.dictionaries, "Dictionaries (fallback)");
    const sample = h("input", { class: "path-input", type: "text", spellcheck: "false", "aria-label": "Text to correct", placeholder: "Je vais a l'ecole demain. I recieve teh letter." });
    const result = h("p", { class: "field-hint" });
    const tryIt = button("Correct", () => {
      const text = sample.value.trim();
      if (!text) return;
      result.textContent = "Correcting…";
      port.check(text).then(
        (c) => (result.textContent = c.fixes ? `${c.text} (${fixes(c.fixes)}${byLine(c.by)})` : `No mistakes found${byLine(c.by)}.`),
        (e: unknown) => (result.textContent = String(e)),
      );
    }, { class: "secondary" });
    let local = !host.options().engine;
    const ready = { model: false, dictionaries: false };
    const paint = () => {
      for (const el of [modelRow, files.el]) el.hidden = !local;
      tryIt.disabled = local && !ready.model && !ready.dictionaries;
    };
    const engine = enginePanel(providers, host, "text", (isLocal) => ((local = isLocal), paint()), OWN_ENGINE);
    root.append(engine.el, modelRow, files.el, dictionaries.el, row("Try it", h("div", { class: "recorder" }, sample, tryIt)), result);
    const watching = [
      port.watchModel((model) => {
        picker.setOptions(modelOptions(model.installed));
        picker.set(model.model);
        ready.model = model.state === "ready";
        files.draw(model);
        paint();
      }),
      port.watchDictionaries((info) => {
        ready.dictionaries = info.state === "ready";
        dictionaries.draw(info);
        paint();
      }),
    ];
    paint();
    return () => {
      engine.stop();
      for (const w of watching) void w.then((stop) => stop(), () => {});
    };
  },
  setup({ spelling: port, providers: aiProviders }: { spelling: SpellingPort; providers: ProvidersPort }, host) {
    let phase: Phase = { phase: "idle" };
    let since = 0;
    let model: ModelInfo | null = null;
    let dictionaries: ModelInfo | null = null;
    let providers: readonly AiProvider[] = [];

    const status = h("p", { class: "dict-status" });
    const before = h("p", { class: "muted" });
    const after = h("p", { class: "dict-quote" });
    const card = modelCard(() => host.openSettings());

    const draw = () => {
      status.textContent = statusText(phase);
      const shown = phase.phase === "done" && phase.delivery ? phase : null;
      before.textContent = shown ? `“${shown.original}”` : "";
      after.textContent = shown ? `“${shown.corrected}”` : "";
      before.hidden = after.hidden = !shown;
      const remote = remoteName(providers, host.options());
      if (remote && model) card.draw(remote, { ...model, state: "ready" });
      else if (model) {
        const { name, info } = localCard(model, dictionaries);
        card.draw(name, info);
      }
    };

    void port.watch((next) => {
      if (next.phase !== phase.phase) since = Date.now();
      phase = next;
      draw();
      host.refresh();
    });
    void port.watchModel((next) => {
      model = next;
      draw();
    });
    void port.watchDictionaries((next) => {
      dictionaries = next;
      draw();
    });
    void aiProviders.watch((next) => {
      providers = next;
      draw();
    });

    return {
      panel: (root) => root.append(h("div", { class: "dictation" }, h("div", { class: "dict-now" }, status, before, after), card.el)),
      glance: (now) => spellingGlance(phase, since, now),
    };
  },
});
