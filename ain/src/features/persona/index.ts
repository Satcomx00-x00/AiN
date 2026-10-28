import { button, h, icon } from "../../sdk/dom";
import { choice, folder, secret, text, toggle } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";
import { messageOf, reportProblem } from "../../sdk/report";
import type { ProvidersPort } from "../../shell/providers";
import { type OwnEngine, engineOptions, enginePanel } from "../engine";
import { type CardLine, downloading, modelCard, progressOf, speedometer } from "../model-files";
import type { LocalInfo, Phase, PersonaPort } from "./service";
import { DEFAULT_PROMPT, DEFAULT_VOICE, VOICES, voiceName } from "./voices";

export { voiceName } from "./voices";

const TALK = `<path d="M2.75 4.25a1.5 1.5 0 0 1 1.5-1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5h0a1.25 1.25 0 0 1-1.25-1.25z"/><path d="M5.75 6v1.25M8 5.25v2.75M10.25 6v1.25"/>`;
const STOP = `<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>`;
/** How long a problem stays on the pill. */
const SHOW_PROBLEM_MS = 5000;

/** The feature's own engine: PersonaPlex, installed and run on this computer by the app. */
export const THIS_COMPUTER: OwnEngine = { label: "On this computer", detail: "PersonaPlex, run by the app; it needs an NVIDIA GPU with 24 GB" };

/** Starting, connecting or talking: the main button ends it. */
export const talking = (phase: Phase): boolean => phase.phase === "starting" || phase.phase === "connecting" || phase.phase === "live";

/** The steps the install names itself, as the backend words them. */
const STEP = /^(Getting ready|Making its Python environment|Installing PyTorch|Installing PersonaPlex|No uv here)/;

/** What Settings says about PersonaPlex on this computer, and what its button does there. */
export function localSetup(info: LocalInfo): { detail: string; action: "install" | "remove"; label: string } {
  switch (info.state) {
    case "missing":
      return {
        detail: "Not installed. Installing takes about 5 GB (Python and PyTorch, with uv, or pip without it); then download the model, about 17 GB.",
        action: "install",
        label: "Install",
      };
    case "installing":
      // The install's own words ("Installing PyTorch… 3:07") stand alone; uv's and pip's follow "Installing…".
      return { detail: STEP.test(info.line) ? info.line : `Installing… ${info.line}`.trim(), action: "remove", label: "Cancel" };
    case "ready":
      return {
        detail: info.running ? "Installed, running now" : "Installed. It starts with a conversation, and stops after 10 minutes unused.",
        action: "remove",
        label: "Remove",
      };
    case "error":
      return { detail: `Install failed: ${info.message}`, action: "install", label: "Retry" };
  }
}

/** Once installed, what Settings says about the model's weights while they are not all there, and what its button does; null once downloaded. */
export function modelSetup(info: LocalInfo): { detail: string; action: "download" | "stop"; label: string; progress: number | null } | null {
  if (info.state !== "ready") return null;
  switch (info.model.state) {
    case "missing":
      return { detail: "Installed. Its model isn't downloaded yet; it needs your Hugging Face token.", action: "download", label: "Download · 17 GB", progress: null };
    case "downloading":
      return { detail: downloading(info.model.received, info.model.total), action: "stop", label: "Stop", progress: progressOf(info.model.received, info.model.total) };
    case "ready":
      return null;
    case "error":
      return { detail: `Download failed: ${info.model.message}`, action: "download", label: "Retry", progress: null };
  }
}

/** The island's card while PersonaPlex on this computer isn't ready to talk: what it lacks, and how far its install or download is; null once ready. */
export function localLine(info: LocalInfo): CardLine | null {
  const line = (detail: string, state: string, progress: number | null = null): CardLine => ({ title: "PersonaPlex", detail, progress, state, dir: info.dir });
  switch (info.state) {
    case "missing":
      return line("Not installed", "missing");
    case "installing":
      return line("Installing…", "downloading");
    case "error":
      return line(`Install failed: ${info.message}`, "error");
    case "ready":
      break;
  }
  switch (info.model.state) {
    case "missing":
      return line("Model not downloaded yet", "missing");
    case "downloading":
      return { ...line(downloading(info.model.received, info.model.total), "downloading", progressOf(info.model.received, info.model.total)), received: info.model.received };
    case "error":
      return line(`Download failed: ${info.model.message}`, "error");
    case "ready":
      return null;
  }
}

/** Settings' row for PersonaPlex on this computer: its state, and the buttons to show its folder, install it or remove it, and download its model. */
function localRow(port: PersonaPort): { readonly el: HTMLElement; draw(info: LocalInfo): void; fail(e: unknown): void } {
  let current: LocalInfo | null = null;
  const detail = h("div", { class: "field-hint" });
  const action = button("", () => {
    const installing = current && localSetup(current).action === "install";
    const run = installing ? port.install() : port.remove();
    run.catch((e: unknown) => reportProblem(installing ? "Couldn't install PersonaPlex" : "Couldn't remove PersonaPlex", e, "PERSONA_SETUP"));
  }, { class: "secondary" });
  const model = button("", () => {
    const stopping = current && modelSetup(current)?.action === "stop";
    const run = stopping ? port.cancelDownload() : port.download();
    run.catch((e: unknown) => reportProblem(stopping ? "Couldn't stop the download" : "Couldn't download PersonaPlex's model", e, "PERSONA_MODEL"));
  }, { class: "secondary" });
  const folder = button("Show folder", () => void port.openFolder().catch((e: unknown) => reportProblem("Couldn't open PersonaPlex's folder", e, "FOLDER_OPEN")), { class: "secondary" });
  // A test start of the server, as a conversation would: how it goes, under the row's state.
  const result = h("div", { class: "field-hint test-result", role: "status" });
  result.hidden = true;
  let testing = false;
  const show = (text: string, state: "busy" | "ok" | "error") => {
    result.hidden = false;
    result.textContent = text;
    result.dataset.state = state;
  };
  const test = button("Test", () => {
    if (testing) return void port.stopTest().catch((e: unknown) => reportProblem("Couldn't stop the test", e, "PERSONA_TEST"));
    testing = true;
    test.textContent = "Stop test";
    show("Starting PersonaPlex…", "busy");
    port
      .test((line) => testing && show(`Starting PersonaPlex… ${line}`.trim(), "busy"))
      .then(
        (port) => show(`Running: PersonaPlex answered on port ${port}. It stops after 10 minutes unused.`, "ok"),
        (e: unknown) => {
          if (messageOf(e) === "cancelled") return show("Test stopped.", "error");
          show("It didn't start: the notification says why.", "error");
          reportProblem("PersonaPlex didn't start", e, "PERSONA_TEST");
        },
      )
      .finally(() => {
        testing = false;
        test.textContent = "Test";
      });
  }, { class: "secondary", title: "Starts the server as a conversation would, and says how it went" });
  // Until the backend says where PersonaPlex stands, there is nothing to install, remove or download.
  action.hidden = model.hidden = test.hidden = true;
  const bar = h("div", { class: "progress" }, h("i"));
  bar.hidden = true;
  const el = h("div", { class: "field" }, h("div", {}, h("div", { class: "field-label" }, "PersonaPlex"), detail, bar, result), h("div", { class: "recorder" }, folder, test, action, model));
  const fail = (e: unknown) => {
    detail.textContent = "Its state can't be read right now.";
    reportProblem("Couldn't check PersonaPlex on this computer", e, "PERSONA_STATE");
  };
  const speed = speedometer();
  const draw = (info: LocalInfo) => {
    current = info;
    const setup = localSetup(info);
    const weights = modelSetup(info);
    const received = info.state === "ready" && info.model.state === "downloading" ? info.model.received : null;
    const fast = speed(received);
    detail.textContent = weights ? weights.detail + fast : setup.detail;
    detail.title = info.dir;
    bar.hidden = weights?.progress == null;
    bar.style.setProperty("--p", String(weights?.progress ?? 0));
    // While the model downloads, Stop is its button; Remove waits.
    action.hidden = weights?.action === "stop";
    action.textContent = setup.label;
    action.classList.toggle("danger", setup.label === "Remove");
    model.hidden = !weights;
    model.textContent = weights?.label ?? "";
    // Something to test once installed, unless the model is on its way (a test would fetch it too).
    test.hidden = !testing && (info.state !== "ready" || weights?.action === "stop");
  };
  return { el, draw, fail };
}

/** The pill while talking: who speaks, and how loud the user is; then briefly what went wrong. */
export function personaGlance(phase: Phase, since: number, now: number): Glance | null {
  switch (phase.phase) {
    case "starting":
      return { text: "Starting…", mark: "eq", wide: true };
    case "connecting":
      return { text: "Connecting…", mark: "eq", wide: true };
    case "live":
      return phase.speaking ? { text: "Speaking", mark: "eq", wide: true } : { text: "Listening", mark: "mic", level: phase.level, wide: true };
    case "error":
      return now - since < SHOW_PROBLEM_MS ? { text: "Conversation failed", tone: "alert" } : null;
    case "idle":
      return null;
  }
}

/** The line next to the button. */
export function statusText(phase: Phase): string {
  switch (phase.phase) {
    case "idle":
      return "Press the talk shortcut (Ctrl+Alt+T) and speak with PersonaPlex. It listens while it speaks: interrupt it anytime. Wear headphones so it doesn't hear itself.";
    case "starting":
      return `Starting PersonaPlex… ${phase.line}`.trim();
    case "connecting":
      return "Connecting to PersonaPlex…";
    case "live":
      return phase.said ? `“${phase.said}”` : "Listening… say hello.";
    case "error":
      return phase.message;
  }
}

/** Full-duplex speech-to-speech conversation with NVIDIA PersonaPlex, on this computer or an AI provider's server. */
export const persona = definePlugin({
  id: "persona",
  label: "Conversation",
  description: "Talk with NVIDIA PersonaPlex, both at once, like on a call.",
  icon: TALK,
  slots: ["glance", "tab"],
  sample: () => ({ text: "Listening", mark: "mic", level: 0.5 }),
  options: {
    // Drawn by the settings panel: this computer, or an AI provider whose server and token it uses.
    ...engineOptions(),
    voice: choice("Voice", DEFAULT_VOICE, VOICES.map((v) => [v, voiceName(v)] as const)),
    prompt: text("Persona", DEFAULT_PROMPT, {
      multiline: true,
      hint: "Who it plays: its role, its manner, what it knows. Taken at the start of each conversation; it uses dictation's microphone.",
      maxLength: 2000,
    }),
    hfToken: secret("Hugging Face token", {
      hint: "For PersonaPlex on this computer: its weights download once you accept their license on huggingface.co/nvidia/personaplex-7b-v1.",
      placeholder: "hf_…",
    }),
    cpuOffload: toggle(
      "Offload to the CPU",
      false,
      "PersonaPlex's own way to run on a GPU short of 24 GB, with part of the model in RAM. It doesn't work yet (PersonaPlex stops at its first step), and would be too slow to talk live anyway.",
    ),
    modelDir: folder("Model folder", "Default folder", "Where PersonaPlex on this computer is installed, with its weights."),
  },
  commands: [
    {
      id: "talk",
      label: "Talk",
      description: "Starts a conversation with PersonaPlex; press again to end it.",
      shortcut: "Ctrl+Alt+KeyT",
      surface: "action",
    },
  ],
  settingsPanel(root, { persona: port, providers }: { persona: PersonaPort; providers: ProvidersPort }, host) {
    const local = localRow(port);
    const engine = enginePanel(providers, host, "s2s", (here) => void (local.el.hidden = !here), THIS_COMPUTER);
    root.append(engine.el, local.el);
    const watching = port.watchLocal(local.draw);
    watching.catch(local.fail);
    return () => {
      engine.stop();
      void watching.then((stop) => stop(), () => {});
    };
  },
  setup({ persona: port }: { persona: PersonaPort }, host) {
    let phase: Phase = { phase: "idle" };
    let since = 0;

    let mainIcon = TALK;
    const main = button(icon(TALK), () => void port.control("toggle").catch(() => {}), { class: "round primary dict-main", "aria-label": "Start talking" });
    const status = h("p", { class: "dict-status" });
    const level = h("div", { class: "bar thin dict-level" }, h("i"));
    const settings = button("Settings", () => host.openSettings(), { class: "chip" });
    // PersonaPlex on this computer, read-only, until it is installed and downloaded: Settings does both.
    const card = modelCard(() => host.openSettings());
    card.el.hidden = true;
    const drawLocal = (info: LocalInfo) => {
      const line = host.options().engine ? null : localLine(info);
      card.el.hidden = !line;
      if (line) card.show(line);
      host.refresh();
    };

    const draw = () => {
      const busy = talking(phase);
      main.dataset.state = busy ? "rec" : "";
      main.setAttribute("aria-label", busy ? "End the conversation" : "Start talking");
      const markup = busy ? STOP : TALK;
      if (markup !== mainIcon) main.replaceChildren(icon(markup));
      mainIcon = markup;
      status.textContent = statusText(phase);
      status.classList.toggle("dict-quote", phase.phase === "live" && !!phase.said);
      level.hidden = phase.phase !== "live";
      level.style.setProperty("--p", String(phase.phase === "live" ? phase.level : 0));
      settings.hidden = busy;
    };

    void port.watch((next) => {
      if (next.phase !== phase.phase) since = Date.now();
      phase = next;
      draw();
      host.refresh();
    });
    // The backend says again when the settings change, so switching engines redraws the card.
    void port.watchLocal(drawLocal).catch(() => {});

    return {
      panel: (root) => root.append(h("div", { class: "dictation" }, h("div", { class: "dict-head" }, main, h("div", { class: "dict-now" }, status, level), settings), card.el)),
      glance: (now) => personaGlance(phase, since, now),
    };
  },
});
