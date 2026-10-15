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

const progressOf = (received: number, total: number) => (total ? received / total : 0);

/** What the island's tab says about the chosen model: read-only, since it is chosen and managed in Settings. */
export function modelLine(info: ModelInfo): { title: string; detail: string; progress: number | null } {
  const { name } = modelById(info.model);
  switch (info.state) {
    case "missing":
      return { title: name, detail: "Not downloaded yet", progress: null };
    case "downloading":
      return { title: name, detail: `Downloading… ${mb(info.received)} of ${mb(info.total)}`, progress: progressOf(info.received, info.total) };
    case "ready":
      return { title: name, detail: "Ready", progress: null };
    case "error":
      return { title: name, detail: `Download failed: ${info.message}`, progress: null };
  }
}

/** What Settings says about the chosen model, and what its button does there. */
export function modelSetup(info: ModelInfo): { detail: string; action: "download" | "stop" | "remove"; label: string; progress: number | null } {
  const { about } = modelById(info.model);
  switch (info.state) {
    case "missing":
      return { detail: `${about}. Not downloaded yet.`, action: "download", label: `Download · ${mb(info.size)}`, progress: null };
    case "downloading":
      return { detail: `Downloading… ${mb(info.received)} of ${mb(info.total)}`, action: "stop", label: "Stop", progress: progressOf(info.received, info.total) };
    case "ready":
      return { detail: `Downloaded, in ${info.dir}`, action: "remove", label: "Remove", progress: null };
    case "error":
      return { detail: `Download failed: ${info.message}`, action: "download", label: "Retry", progress: null };
  }
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
      "Download it just below. Models you've downloaded stay, so switching back is instant.",
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
  // Choosing, downloading and storing the model happen here, in Settings; the island only dictates.
  settingsPanel(root, { dictation: port }: { dictation: DictationPort }) {
    let model: ModelInfo | null = null;
    const detail = h("div", { class: "field-hint" });
    const bar = h("div", { class: "progress" }, h("i"));
    const action = button("", () => {
      const setup = model && modelSetup(model);
      const run = setup?.action === "download" ? port.download() : setup ? port.remove() : null;
      run?.catch((e: unknown) => (detail.textContent = String(e)));
    }, { class: "secondary" });
    const folder = button("Show folder", () => void port.openFolder().catch(() => {}), { class: "secondary" });
    root.append(h("div", { class: "field" }, h("div", {}, h("div", { class: "field-label" }, "Model files"), detail, bar), h("div", { class: "recorder" }, folder, action)));
    const draw = () => {
      if (!model) return;
      const setup = modelSetup(model);
      detail.textContent = setup.detail;
      detail.title = model.dir;
      bar.hidden = setup.progress === null;
      bar.style.setProperty("--p", String(setup.progress ?? 0));
      action.textContent = setup.label;
      action.classList.toggle("danger", setup.action === "remove");
    };
    const watching = port.watchModel((next) => {
      model = next;
      draw();
    });
    return () => void watching.then((stop) => stop(), () => {});
  },
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

    // The model, read-only: it is chosen, downloaded and stored in Settings.
    const modelTitle = h("strong");
    const modelDetail = h("span", { class: "muted" });
    const modelBar = h("div", { class: "bar thin" }, h("i"));
    const setUp = button("Set up in Settings", () => host.openSettings(), { class: "chip" });
    const modelCard = h("div", { class: "dict-model" }, h("div", { class: "dict-model-text" }, modelTitle, modelDetail, modelBar), setUp);

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
        modelDetail.title = model.dir;
        // Ready, there's nothing to set up; while downloading, Settings is where it can be stopped.
        setUp.hidden = model.state === "ready";
        setUp.textContent = model.state === "downloading" ? "Settings" : "Set up in Settings";
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
