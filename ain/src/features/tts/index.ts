import { button, h, icon } from "../../sdk/dom";
import { choice, folder, number } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";
import { type SelectOption, select } from "../../sdk/select";
import { modelCard, modelFiles } from "../model-files";
import type { ModelInfo, Phase, TtsPort } from "./service";
import { DEFAULT_MODEL, MODELS, modelById } from "./models";

const SPEAKER = `<path d="M2.75 6.25v3.5h2.5L8.75 12.5v-9L5.25 6.25z"/><path d="M11 5.75a3.25 3.25 0 0 1 0 4.5M12.75 3.75a6 6 0 0 1 0 8.5"/>`;
const STOP = `<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>`;
/** How long a problem stays on the pill. */
const SHOW_PROBLEM_MS = 5000;
/** What "Try the voice" reads. */
export const SAMPLE = "Hello! This is how I sound. Select any text and press the shortcut to hear it.";

/** Reading or getting ready to: the main button stops it. */
export const reading = (phase: Phase): boolean => phase.phase === "preparing" || phase.phase === "speaking";

/** The pill while reading, then briefly what went wrong. `since` is when the phase began. */
export function ttsGlance(phase: Phase, since: number, now: number): Glance | null {
  const shown = now - since < SHOW_PROBLEM_MS;
  switch (phase.phase) {
    case "preparing":
      return { text: "Preparing…", mark: "eq", wide: true };
    case "speaking":
      return { text: "Reading aloud", mark: "eq", wide: true };
    case "needsModel":
      return shown ? { text: "Get a voice first", tone: "alert", wide: true } : null;
    case "nothingSelected":
      return shown ? { text: "Select text first", tone: "muted" } : null;
    case "error":
      return shown ? { text: "Reading failed", tone: "alert" } : null;
    case "idle":
      return null;
  }
}

/** The line next to the button. */
export function statusText(phase: Phase, last: string): string {
  switch (phase.phase) {
    case "idle":
      return last ? `“${last}”` : "Select text in any app and press the read aloud shortcut (Ctrl+Alt+R) to hear it.";
    case "needsModel":
      return "Choose and download a voice in Settings to start reading.";
    case "nothingSelected":
      return "No text is selected. Select some, then press the shortcut again.";
    case "preparing":
      return "Preparing the voice…";
    case "speaking":
      return `“${phase.text}”`;
    case "error":
      return phase.message;
  }
}

/** The voice models as Settings lists them: what each is, its size, and whether it's downloaded. */
export const modelOptions = (installed: readonly string[]): SelectOption[] =>
  MODELS.map((m) => ({ value: m.id, label: m.name, detail: m.about, meta: `${m.mb} MB`, badge: installed.includes(m.id) ? "Downloaded" : undefined }));

/** The speakers of a model, by index; none for one-voice models. */
export const voiceOptions = (model: string): SelectOption[] => modelById(model).voices.map((label, i) => ({ value: String(i), label }));

/** Text to speech, on this computer: reads the selected text out loud. */
export const tts = definePlugin({
  id: "tts",
  label: "Read aloud",
  description: "Text to speech, on this computer.",
  icon: SPEAKER,
  slots: ["glance", "tab"],
  options: {
    // These two are drawn by the settings panel, which knows the downloads and each model's voices.
    model: { ...choice("Voice model", DEFAULT_MODEL, MODELS.map((m) => [m.id, m.name] as const)), inPanel: true },
    voice: { ...number("Voice", 0, { min: 0, max: 63 }), inPanel: true },
    speed: number("Speed", 1, { min: 0.5, max: 2, step: 0.05, unit: "×" }),
    modelDir: folder("Model folder", "Default folder"),
  },
  commands: [
    {
      id: "read",
      label: "Read aloud",
      description: "Reads the selected text out loud; press again to stop.",
      shortcut: "Ctrl+Alt+KeyR",
      surface: "action",
    },
  ],
  // Choosing the model and its voice, and downloading the model, happen here in Settings.
  settingsPanel(root, { tts: port }: { tts: TtsPort }, host) {
    const voice = String(host.options().voice);
    const picker = select(modelOptions([]), host.options().model, (id) => host.setOptions({ model: id, voice: 0 }), "Voice model");
    const voices = select(voiceOptions(host.options().model), voice, (v) => host.setOptions({ voice: Number(v) }), "Voice");
    const files = modelFiles(port);
    const sample = button("Try the voice", () => void port.speak(SAMPLE).catch(() => {}), { class: "secondary" });
    const row = (label: string, control: HTMLElement) => h("div", { class: "field wide" }, h("div", {}, h("div", { class: "field-label" }, label)), control);
    const voiceRow = row("Voice", voices.el);
    root.append(row("Voice model", picker.el), voiceRow, files.el, h("div", { class: "field" }, h("div", {}, h("div", { class: "field-label" }, "Preview")), sample));
    const watching = port.watchModel((model) => {
      picker.setOptions(modelOptions(model.installed));
      picker.set(model.model);
      const options = voiceOptions(model.model);
      voices.setOptions(options);
      voices.set(String(Math.min(host.options().voice, Math.max(options.length - 1, 0))));
      voiceRow.hidden = !options.length;
      sample.disabled = model.state !== "ready";
      files.draw(model);
    });
    return () => void watching.then((stop) => stop(), () => {});
  },
  setup({ tts: port }: { tts: TtsPort }, host) {
    let phase: Phase = { phase: "idle" };
    let since = 0;
    let model: ModelInfo | null = null;
    let last = "";

    let mainIcon = SPEAKER;
    const main = button(icon(SPEAKER), () => void (reading(phase) ? port.control("stop") : port.speak(last)).catch(() => {}), {
      class: "round primary dict-main",
      "aria-label": "Read again",
    });
    const status = h("p", { class: "dict-status" });
    // The model, read-only: it is chosen, downloaded and stored in Settings.
    const card = modelCard(() => host.openSettings());

    const draw = () => {
      const busy = reading(phase);
      main.dataset.state = busy ? "rec" : "";
      main.setAttribute("aria-label", busy ? "Stop reading" : "Read again");
      const markup = busy ? STOP : SPEAKER;
      if (markup !== mainIcon) main.replaceChildren(icon(markup));
      mainIcon = markup;
      main.disabled = !busy && (!last || model?.state !== "ready");
      status.textContent = statusText(phase, last);
      status.classList.toggle("dict-quote", phase.phase === "speaking" || (phase.phase === "idle" && !!last));
      if (model) card.draw(modelById(model.model).name, model);
    };

    void port.watch((next) => {
      if (next.phase !== phase.phase) since = Date.now();
      phase = next;
      if (next.phase === "speaking") last = next.text;
      draw();
      host.refresh();
    });
    void port.watchModel((next) => {
      model = next;
      draw();
    });

    return {
      panel: (root) => root.append(h("div", { class: "dictation" }, h("div", { class: "dict-head" }, main, h("div", { class: "dict-now" }, status)), card.el)),
      glance: (now) => ttsGlance(phase, since, now),
    };
  },
});
