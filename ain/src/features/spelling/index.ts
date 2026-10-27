import { button, h } from "../../sdk/dom";
import { choice, folder } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";
import { fieldRow as row, modelCard, modelFiles } from "../model-files";
import { type OwnEngine, engineOptions, enginePanel, remoteName } from "../engine";
import type { AiProvider, ProvidersPort } from "../../shell/providers";
import type { ModelInfo, Phase, SpellingPort } from "./service";

const CHECK = `<path d="M2.5 11.5 5 4.5l2.5 7M3.4 9h3.2"/><path d="m8.5 9.75 2 2 3.5-4.5"/>`;
/** How long a result stays on the pill. */
const SHOW_DONE_MS = 2500;
const SHOW_PROBLEM_MS = 5000;
/** The dictionaries, as the island and Settings name them. */
export const DICTIONARIES = "Dictionaries · French & English";

/** Spelling's own engine: dictionaries, which fix words but not grammar. */
export const OWN_ENGINE: OwnEngine = { label: "On this computer", detail: "Dictionaries downloaded below fix misspelled words; nothing leaves the computer" };

/** "1 fix", "3 fixes". */
export const fixes = (n: number): string => `${n} ${n === 1 ? "fix" : "fixes"}`;

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
      return age < SHOW_PROBLEM_MS ? { text: "Get the dictionaries first", tone: "alert", wide: true } : null;
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
      return "Download the dictionaries in Settings, or choose an AI provider, to start correcting.";
    case "nothingSelected":
      return "No text is selected. Select some, then press the shortcut again.";
    case "checking":
      return "Correcting…";
    case "done":
      if (!phase.delivery) return "No mistakes found.";
      return phase.delivery === "copied" ? `${fixes(phase.fixes)}, copied: paste it where you want it.` : `${fixes(phase.fixes)}, typed over the selection.`;
    case "error":
      return phase.message;
  }
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
    language: choice("Language", "auto", [
      ["auto", "Detect"],
      ["fr", "French"],
      ["en", "English"],
    ]),
    apply: choice("Correction", "replace", [
      ["replace", "Replace the selection"],
      ["copy", "Copy it"],
    ], "Replacing types the corrected text over the selection; where typing isn't allowed, it is copied."),
    modelDir: folder("Dictionaries folder", "Default folder"),
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
  // Choosing the engine, downloading the dictionaries and trying a correction happen here in Settings.
  settingsPanel(root, { spelling: port, providers }: { spelling: SpellingPort; providers: ProvidersPort }, host) {
    const files = modelFiles(port);
    const sample = h("input", { class: "path-input", type: "text", spellcheck: "false", "aria-label": "Text to correct", placeholder: "Je vais a l'ecole demain. I recieve teh letter." });
    const result = h("p", { class: "field-hint" });
    const tryIt = button("Correct", () => {
      const text = sample.value.trim();
      if (!text) return;
      result.textContent = "Correcting…";
      port.check(text).then(
        (c) => (result.textContent = c.fixes ? `${c.text} (${fixes(c.fixes)})` : "No mistakes found."),
        (e: unknown) => (result.textContent = String(e)),
      );
    }, { class: "secondary" });
    let local = !host.options().engine;
    let ready = false;
    const paint = () => {
      files.el.hidden = !local;
      tryIt.disabled = local && !ready;
    };
    const engine = enginePanel(providers, host, "text", (isLocal) => ((local = isLocal), paint()), OWN_ENGINE);
    root.append(engine.el, files.el, row("Try it", h("div", { class: "recorder" }, sample, tryIt)), result);
    const watching = port.watchModel((model) => {
      ready = model.state === "ready";
      files.draw(model);
      paint();
    });
    paint();
    return () => {
      engine.stop();
      void watching.then((stop) => stop(), () => {});
    };
  },
  setup({ spelling: port, providers: aiProviders }: { spelling: SpellingPort; providers: ProvidersPort }, host) {
    let phase: Phase = { phase: "idle" };
    let since = 0;
    let model: ModelInfo | null = null;
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
      if (model) card.draw(remote ?? DICTIONARIES, remote ? { ...model, state: "ready" } : model);
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
