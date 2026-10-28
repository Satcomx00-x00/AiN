import { button, h, icon } from "../../sdk/dom";
import { choice, folder, text, toggle } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";
import { type SelectOption, select } from "../../sdk/select";
import type { ClipboardPort } from "../clipboard/service";
import { keepLoaded, fieldRow as row, modelCard, modelFiles, modelLine as line } from "../model-files";
import { engineOptions, enginePanel, remoteName } from "../engine";
import type { AiProvider, ProvidersPort } from "../../shell/providers";
import type { DictationPort, Microphone, ModelInfo, Phase } from "./service";
import { DEFAULT_MODEL, MODELS, modelById } from "./models";

export { mb, modelSetup } from "../model-files";

const MIC = `<rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25"/><path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2"/>`;
const STOP = `<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>`;
/** How long a result stays on the pill. */
const SHOW_DONE_MS = 2500;
const SHOW_PROBLEM_MS = 5000;

export const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** The pill while dictating: a recording dot and the time, then a brief result. `since` is when the phase began. */
export function dictationGlance(phase: Phase, since: number, now: number): Glance | null {
  const age = now - since;
  switch (phase.phase) {
    case "listening":
      return { text: clock(phase.seconds), mark: "rec", level: phase.level, wide: true };
    case "transcribing":
      return { text: "Transcribing…", mark: "eq", wide: true };
    case "done":
      if (age >= SHOW_DONE_MS) return null;
      return { text: !phase.text ? "Nothing heard" : phase.delivery === "copied" ? "Copied" : "Typed", tone: "muted" };
    case "needsModel":
      return age < SHOW_PROBLEM_MS ? { text: "Get the model first", tone: "alert", wide: true } : null;
    case "error":
      return age < SHOW_PROBLEM_MS ? { text: "Dictation failed", tone: "alert" } : null;
    case "idle":
      return null;
  }
}

/** What the island's tab says about the chosen model: read-only, since it is chosen and managed in Settings. */
export const modelLine = (info: ModelInfo) => line(modelById(info.model).name, info);

/** The speech models as Settings lists them: what each is, its size, and whether it's downloaded. */
export const modelOptions = (installed: readonly string[]): SelectOption[] =>
  MODELS.map((m) => ({ value: m.id, label: m.name, detail: m.about, meta: `${m.mb} MB`, badge: installed.includes(m.id) ? "Downloaded" : undefined }));

/** The microphones to choose from: the system's default first, and the chosen one even if it's unplugged. */
export function micOptions(mics: readonly Microphone[], chosen: string): SelectOption[] {
  const known = mics.some((m) => m.id === chosen);
  return [
    { value: "", label: "System default" },
    ...mics.map((m) => ({ value: m.id, label: m.name })),
    ...(chosen && !known ? [{ value: chosen, label: "Disconnected microphone", detail: "The system default is used meanwhile" }] : []),
  ];
}

/** The line next to the mic button; after a dictation, what was typed. */
export function statusText(phase: Phase): string {
  switch (phase.phase) {
    case "idle":
      return "Press the dictation shortcut (Ctrl+Alt+D) and speak: the words are typed where your cursor is, or copied to paste where the system doesn't allow typing.";
    case "needsModel":
      return "Choose and download a speech model in Settings to start dictating.";
    case "listening":
      return "Listening… press the shortcut again to finish.";
    case "transcribing":
      return "Transcribing…";
    case "done":
      if (!phase.text) return "Nothing heard. Try again a little closer to the mic.";
      return phase.delivery === "copied" ? `“${phase.text}” — copied, paste it with Ctrl+V.` : `“${phase.text}”`;
    case "error":
      return phase.message;
  }
}

/** Speech to text, on this machine or by an AI provider, typed into whatever app has the cursor. */
export const dictation = definePlugin({
  id: "dictation",
  label: "Dictation",
  description: "Speech to text, on this computer or by an AI provider.",
  icon: MIC,
  slots: ["glance", "tab"],
  options: {
    mode: choice("Shortcut", "toggle", [
      ["toggle", "Press to start and stop"],
      ["hold", "Hold to talk"],
    ]),
    // These are drawn by the settings panel, which knows the providers, the microphones and the downloads.
    ...engineOptions(),
    microphone: { ...text("Microphone"), inPanel: true },
    model: { ...choice("Speech model", DEFAULT_MODEL, MODELS.map((m) => [m.id, m.name] as const)), inPanel: true },
    modelDir: folder("Model folder", "Default folder"),
    keepLoaded: keepLoaded(),
    trailingSpace: toggle("Space after the text", true),
    typing: choice(
      "Put the text in by",
      "auto",
      [
        ["auto", "Automatic"],
        ["paste", "Pasting"],
        ["keys", "Typing keys"],
      ],
      "Pasting works with any keyboard layout (AZERTY…) but replaces the clipboard. Automatic pastes on Linux, where typed keys can come out wrong, and types elsewhere.",
    ),
  },
  commands: [
    {
      id: "toggle",
      label: "Dictate",
      description: "Types what you say where the cursor is.",
      shortcut: "Ctrl+Alt+KeyD",
      surface: "action",
    },
  ],
  // Choosing the microphone and the model, and downloading the model, happen here in Settings.
  settingsPanel(root, { dictation: port, providers }: { dictation: DictationPort; providers: ProvidersPort }, host) {
    let mics: Microphone[] = [];
    const mic = select(micOptions([], host.options().microphone), host.options().microphone, (id) => host.setOptions({ microphone: id }), "Microphone");
    const picker = select(modelOptions([]), host.options().model, (id) => host.setOptions({ model: id }), "Speech model");
    const files = modelFiles(port);
    const modelRow = row("Speech model", picker.el);
    const engine = enginePanel(providers, host, "stt", (local) => {
      for (const el of [modelRow, files.el]) el.hidden = !local;
    });
    root.append(row("Microphone", mic.el), engine.el, modelRow, files.el);
    // Microphones come and go: look again whenever the window comes back to the front.
    const listMics = () =>
      port.microphones().then((next) => {
        mics = next;
        const chosen = host.options().microphone;
        mic.setOptions(micOptions(mics, chosen));
        mic.set(chosen);
      }, () => {});
    void listMics();
    window.addEventListener("focus", listMics);
    const watching = port.watchModel((model) => {
      picker.setOptions(modelOptions(model.installed));
      picker.set(model.model);
      files.draw(model);
    });
    return () => {
      window.removeEventListener("focus", listMics);
      engine.stop();
      void watching.then((stop) => stop(), () => {});
    };
  },
  setup({ dictation: port, clipboard, providers: aiProviders }: { dictation: DictationPort; clipboard: ClipboardPort; providers: ProvidersPort }, host) {
    let phase: Phase = { phase: "idle" };
    let since = 0;
    let model: ModelInfo | null = null;
    let providers: readonly AiProvider[] = [];
    let lastText = "";

    let mainIcon = MIC;
    const main = button(icon(MIC), () => void port.control("toggle").catch(() => {}), { class: "round primary dict-main", "aria-label": "Start dictating" });
    const status = h("p", { class: "dict-status" });
    const level = h("div", { class: "bar thin dict-level" }, h("i"));
    const copy = button("Copy", () => void clipboard.copy(lastText).catch(() => {}), { class: "chip" });

    // The model, read-only: it is chosen, downloaded and stored in Settings.
    const card = modelCard(() => host.openSettings());

    const draw = () => {
      const listening = phase.phase === "listening";
      main.dataset.state = listening ? "rec" : "";
      main.setAttribute("aria-label", listening ? "Stop dictating" : "Start dictating");
      const markup = listening ? STOP : MIC;
      if (markup !== mainIcon) main.replaceChildren(icon(markup));
      mainIcon = markup;
      const remote = remoteName(providers, host.options());
      main.disabled = phase.phase === "transcribing" || (!remote && model?.state !== "ready");
      status.textContent = statusText(phase);
      status.classList.toggle("dict-quote", phase.phase === "done" && !!phase.text);
      copy.hidden = !(phase.phase === "done" && phase.text);
      level.hidden = !listening;
      level.style.setProperty("--p", String(phase.phase === "listening" ? phase.level : 0));

      if (model) card.draw(remote ?? modelById(model.model).name, remote ? { ...model, state: "ready" } : model);
    };

    void port.watch((next) => {
      if (next.phase !== phase.phase) since = Date.now();
      phase = next;
      if (next.phase === "done") lastText = next.text;
      draw();
      host.refresh();
    });
    void port.watchModel((next) => {
      model = next;
      draw();
    });
    // Follows the settings too: switching engines there redraws the card.
    void aiProviders.watch((next) => {
      providers = next;
      draw();
    });

    return {
      panel: (root) => root.append(h("div", { class: "dictation" }, h("div", { class: "dict-head" }, main, h("div", { class: "dict-now" }, status, level), copy), card.el)),
      glance: (now) => dictationGlance(phase, since, now),
      ambient: () => (phase.phase === "listening" ? "#ff453a" : null),
    };
  },
});
