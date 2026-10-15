import { button, h, icon } from "../../sdk/dom";
import { choice, folder, toggle } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";
import type { ClipboardPort } from "../clipboard/service";
import type { DictationPort, ModelInfo, Phase } from "./service";
import { DEFAULT_MODEL, MODELS, modelById } from "./models";

const MIC = `<rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25"/><path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2"/>`;
const STOP = `<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>`;
/** How long a result stays on the pill. */
const SHOW_DONE_MS = 2500;
const SHOW_PROBLEM_MS = 5000;

/** A long path cut from the start, so its last folders stay readable: "…\Models\parakeet-…". */
export const shortPath = (path: string, max = 44): string => (path.length <= max ? path : `…${path.slice(path.length - max + 1)}`);

export const mb = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`;
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

/** What the model card says about the chosen model. */
export function modelLine(info: ModelInfo): { title: string; detail: string; progress: number | null } {
  const { name, about } = modelById(info.model);
  switch (info.state) {
    case "missing":
      return { title: name, detail: about, progress: null };
    case "downloading":
      return { title: name, detail: `Downloading… ${mb(info.received)} of ${mb(info.total)}`, progress: info.total ? info.received / info.total : 0 };
    case "ready":
      return { title: name, detail: shortPath(info.dir, 34), progress: null };
    case "error":
      return { title: name, detail: `Download failed: ${info.message}`, progress: null };
  }
}

/** The model `step` places away from `id` in the list, wrapping around. */
export const nextModel = (id: string, step: 1 | -1): string => {
  const at = MODELS.findIndex((m) => m.id === id);
  return MODELS[(Math.max(at, 0) + step + MODELS.length) % MODELS.length]!.id;
};

/** The line next to the mic button; after a dictation, what was typed. */
export function statusText(phase: Phase): string {
  switch (phase.phase) {
    case "idle":
      return "Press the dictation shortcut (Ctrl+Alt+D) and speak: the words are typed where your cursor is, or copied to paste where the system doesn't allow typing.";
    case "needsModel":
      return "Download the speech model below to start dictating.";
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

/** Speech to text, on this machine, typed into whatever app has the cursor. */
export const dictation = definePlugin({
  id: "dictation",
  label: "Dictation",
  description: "Speak and your words are typed where the cursor is. Local speech recognition (Parakeet, Whisper…), nothing sent online.",
  icon: MIC,
  slots: ["glance", "tab"],
  options: {
    mode: choice(
      "Shortcut",
      "toggle",
      [
        ["toggle", "Press to start, press again to stop"],
        ["hold", "Hold to talk"],
      ],
      "With hold to talk, dictation stops as soon as you release the keys.",
    ),
    model: choice(
      "Speech model",
      DEFAULT_MODEL,
      MODELS.map((m) => [m.id, `${m.name} — ${m.about} · ${m.mb} MB`] as const),
      "Download it from the Dictation tab of the island (or switch models there with the arrows). Models you've downloaded stay, so switching back is instant.",
    ),
    modelDir: folder(
      "Model folder",
      "Default: the app's data folder",
      "Where the speech models are stored, each in its own subfolder. After changing it, download the models again or move their subfolders there.",
    ),
    trailingSpace: toggle("Add a space after the text", true, "So the next sentence doesn't stick to this one."),
  },
  commands: [
    {
      id: "toggle",
      label: "Dictate",
      description: "Listens to the microphone, then types what you said where the cursor is.",
      shortcut: "Ctrl+Alt+KeyD",
      surface: "action",
    },
  ],
  setup({ dictation: port, clipboard }: { dictation: DictationPort; clipboard: ClipboardPort }, host) {
    let phase: Phase = { phase: "idle" };
    let since = 0;
    let model: ModelInfo | null = null;
    let lastText = "";

    let mainIcon = MIC;
    const main = button(icon(MIC), () => void port.control("toggle").catch(() => {}), { class: "round primary dict-main", "aria-label": "Start dictating" });
    const status = h("p", { class: "dict-status" });
    const level = h("div", { class: "bar thin dict-level" }, h("i"));
    const copy = button("Copy", () => void clipboard.copy(lastText).catch(() => {}), { class: "chip" });

    const modelTitle = h("strong");
    const modelDetail = h("span", { class: "muted" });
    const modelBar = h("div", { class: "bar thin" }, h("i"));
    const modelAction = button("", () => {
      const run = model?.state === "ready" || model?.state === "downloading" ? port.remove() : port.download();
      run.catch((e: unknown) => console.error("[island] dictation model", e));
    }, { class: "chip" });
    const FOLDER = `<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>`;
    const openFolder = button(icon(FOLDER), () => void port.openFolder().catch(() => {}), { class: "round dict-folder", "aria-label": "Show the model folder" });
    const switchTo = (step: 1 | -1) => host.setOptions({ model: nextModel(model?.model ?? host.options().model, step) });
    const prev = button(icon(`<path d="M10 3.5 5.5 8l4.5 4.5"/>`), () => switchTo(-1), { class: "dict-switch", "aria-label": "Previous speech model" });
    const next = button(icon(`<path d="M6 3.5 10.5 8 6 12.5"/>`), () => switchTo(1), { class: "dict-switch", "aria-label": "Next speech model" });
    const count = h("span", { class: "dict-count muted" });
    const modelCard = h(
      "div",
      { class: "dict-model" },
      h("div", { class: "dict-model-text" }, h("div", { class: "dict-model-name" }, prev, modelTitle, next, count), modelDetail, modelBar),
      openFolder,
      modelAction,
    );

    const draw = () => {
      const listening = phase.phase === "listening";
      main.dataset.state = listening ? "rec" : "";
      main.setAttribute("aria-label", listening ? "Stop dictating" : "Start dictating");
      const markup = listening ? STOP : MIC;
      if (markup !== mainIcon) main.replaceChildren(icon(markup));
      mainIcon = markup;
      main.disabled = phase.phase === "transcribing" || model?.state !== "ready";
      status.textContent = statusText(phase);
      status.classList.toggle("dict-quote", phase.phase === "done" && !!phase.text);
      copy.hidden = !(phase.phase === "done" && phase.text);
      level.hidden = !listening;
      level.style.setProperty("--p", String(phase.phase === "listening" ? phase.level : 0));

      if (model) {
        const line = modelLine(model);
        modelTitle.textContent = line.title;
        modelDetail.textContent = line.detail;
        modelBar.hidden = line.progress === null;
        modelBar.style.setProperty("--p", String(line.progress ?? 0));
        modelCard.dataset.state = model.state;
        openFolder.title = model.dir;
        modelDetail.title = model.state === "ready" ? model.dir : modelDetail.textContent;
        prev.disabled = next.disabled = model.state === "downloading" || phase.phase === "listening" || phase.phase === "transcribing";
        const position = MODELS.findIndex((m) => m.id === model?.model) + 1;
        count.textContent = `${position}/${MODELS.length}`;
        count.title = `${model.installed.length} downloaded`;
        modelAction.textContent =
          model.state === "ready" ? "Remove" : model.state === "downloading" ? "Stop" : model.state === "error" ? "Retry" : `Download · ${mb(model.state === "missing" ? model.size : 0)}`;
      }
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

    return {
      panel: (root) => root.append(h("div", { class: "dictation" }, h("div", { class: "dict-head" }, main, h("div", { class: "dict-now" }, status, level), copy), modelCard)),
      glance: (now) => dictationGlance(phase, since, now),
      ambient: () => (phase.phase === "listening" ? "#ff453a" : null),
    };
  },
});
