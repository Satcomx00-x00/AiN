import { button, h, icon } from "../../sdk/dom";
import { toggle } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";
import type { ClipboardPort } from "../clipboard/service";
import { clock } from "../dictation";
import { type OwnEngine, engineOptions, enginePanel } from "../engine";
import type { ProvidersPort } from "../../shell/providers";
import type { Line, Phase, TranscriptPort } from "./service";

const EAR = `<path d="M4.25 6.5a3.75 3.75 0 1 1 7.5 0c0 1.9-1.5 2.6-2.1 3.6-.5.8-.4 2.15-1.65 2.9-1 .6-2.3.2-2.75-.75"/><path d="M6.25 6.5a1.75 1.75 0 0 1 3.5 0"/>`;
const STOP = `<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>`;
const SHOW_PROBLEM_MS = 5000;

type Needs = { transcript: TranscriptPort; clipboard: ClipboardPort; providers: ProvidersPort };

/** Its own engine: dictation's speech model, on this computer. */
export const DICTATION_MODEL: OwnEngine = { label: "On this computer", detail: "Dictation's speech model; nothing leaves the computer" };

/** A line's time of day, as the system writes it (e.g. 14:05:09). */
export const timeOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The transcript as text to paste: one line each, after its time when `times` is on. */
export const asText = (lines: readonly Line[], times: boolean): string => lines.map((l) => (times ? `[${timeOf(l.at)}] ${l.text}` : l.text)).join("\n");

/** The pill while listening: a recording dot and the time, then problems for a moment. `since` is when the phase began. */
export function transcriptGlance(phase: Phase, since: number, now: number): Glance | null {
  const late = now - since >= SHOW_PROBLEM_MS;
  switch (phase.phase) {
    case "listening":
      return { text: clock(phase.seconds), mark: "rec", level: phase.level, wide: true };
    case "finishing":
      return { text: "Finishing…", mark: "eq", wide: true };
    case "needsModel":
      return late ? null : { text: "Get the model first", tone: "alert", wide: true };
    case "error":
      return late ? null : { text: "Transcript failed", tone: "alert" };
    case "idle":
      return null;
  }
}

/** The line next to the main button. */
export function statusText(phase: Phase, heard: number): string {
  switch (phase.phase) {
    case "idle":
      return heard ? `${heard} line${heard === 1 ? "" : "s"} heard.` : "Press the transcript shortcut (Ctrl+Alt+H) to write down what the computer plays: a video, a call, a chat.";
    case "needsModel":
      return "Download a speech model in Dictation's settings, or pick an AI provider in this widget's settings.";
    case "listening":
      return "Listening to the computer's sound…";
    case "finishing":
      return "Writing down the last words…";
    case "error":
      return phase.message;
  }
}

/** What the computer plays, written down as it is heard: on this computer or by an AI provider. */
export const transcript = definePlugin({
  id: "transcript",
  label: "Transcript",
  description: "Writes down the computer's sound: videos, calls, chats.",
  icon: EAR,
  slots: ["glance", "tab"],
  options: {
    ...engineOptions(),
    times: toggle("Show times", true),
  },
  commands: [
    {
      id: "toggle",
      label: "Transcribe the computer's sound",
      description: "Starts writing down what the computer plays; press again to stop.",
      shortcut: "Ctrl+Alt+KeyH",
      surface: "action",
    },
  ],
  settingsPanel(root, { providers }: Needs, host) {
    const engine = enginePanel(providers, host, "stt", () => {}, DICTATION_MODEL);
    root.append(engine.el);
    return () => engine.stop();
  },
  setup({ transcript: port, clipboard }: Needs, host) {
    let phase: Phase = { phase: "idle" };
    let since = 0;
    let lines: readonly Line[] = [];

    let mainIcon = EAR;
    const main = button(icon(EAR), () => void port.control("toggle").catch(() => {}), { class: "round primary dict-main", "aria-label": "Start transcribing" });
    const status = h("p", { class: "dict-status" });
    const level = h("div", { class: "bar thin dict-level" }, h("i"));
    const copy = button("Copy", () => void clipboard.copy(asText(lines, host.options().times)).catch(() => {}), { class: "chip" });
    const clear = button("Clear", () => void port.control("clear").catch(() => {}), { class: "chip" });
    const list = h("ol", { class: "ts-lines", "aria-live": "polite" });

    const draw = () => {
      const listening = phase.phase === "listening";
      main.dataset.state = listening ? "rec" : "";
      main.setAttribute("aria-label", listening ? "Stop transcribing" : "Start transcribing");
      const markup = listening ? STOP : EAR;
      if (markup !== mainIcon) main.replaceChildren(icon(markup));
      mainIcon = markup;
      main.disabled = phase.phase === "finishing";
      status.textContent = statusText(phase, lines.length);
      level.hidden = !listening;
      level.style.setProperty("--p", String(phase.phase === "listening" ? phase.level : 0));
      copy.hidden = clear.hidden = !lines.length;
    };

    const drawLines = () => {
      // Follows the newest line, unless the user scrolled up to read.
      const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      const times = host.options().times;
      list.replaceChildren(...lines.map((l) => h("li", {}, ...(times ? [h("time", {}, timeOf(l.at))] : []), h("span", {}, l.text))));
      if (pinned) list.scrollTop = list.scrollHeight;
      draw();
    };

    void port.watch((next) => {
      if (next.phase !== phase.phase) since = Date.now();
      phase = next;
      draw();
      host.refresh();
    });
    void port.watchLines((next) => {
      lines = next;
      drawLines();
    });

    return {
      panel: (root) =>
        root.append(h("div", { class: "dictation transcript" }, h("div", { class: "dict-head" }, main, h("div", { class: "dict-now" }, status, level), copy, clear), list)),
      glance: (now) => transcriptGlance(phase, since, now),
      ambient: () => (phase.phase === "listening" ? "#ff453a" : null),
    };
  },
});
