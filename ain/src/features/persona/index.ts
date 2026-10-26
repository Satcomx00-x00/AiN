import { button, h, icon } from "../../sdk/dom";
import { choice, text, textProblem } from "../../sdk/options";
import { type Glance, definePlugin } from "../../sdk/plugin";
import type { ProvidersPort } from "../../shell/providers";
import { type OwnEngine, engineOptions, enginePanel } from "../engine";
import { fieldRow as row } from "../model-files";
import type { Phase, PersonaPort } from "./service";
import { DEFAULT_PROMPT, DEFAULT_SERVER, DEFAULT_VOICE, VOICES, voiceName } from "./voices";

export { voiceName } from "./voices";

const TALK = `<path d="M2.75 4.25a1.5 1.5 0 0 1 1.5-1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5h0a1.25 1.25 0 0 1-1.25-1.25z"/><path d="M5.75 6v1.25M8 5.25v2.75M10.25 6v1.25"/>`;
const STOP = `<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/>`;
/** How long a problem stays on the pill. */
const SHOW_PROBLEM_MS = 5000;

/** The feature's own engine: the PersonaPlex server whose address is set on its card. */
export const OWN_SERVER: OwnEngine = { label: "PersonaPlex server", detail: "The address below, with no sign-in" };

const SERVER_HINT = "Where PersonaPlex's server (python -m moshi.server) runs: this computer, or one with a 24 GB GPU; wss:// for a server behind a certificate.";

/** The server's address, as typed and checked. */
const serverField = text("PersonaPlex server", DEFAULT_SERVER, {
  placeholder: DEFAULT_SERVER,
  hint: SERVER_HINT,
  required: true,
  pattern: "((wss?|https?)://)?[^\\s/]+(:\\d+)?/?",
  invalid: "a server address, like ws://localhost:8998",
});

/** Connecting or talking: the main button ends it. */
export const talking = (phase: Phase): boolean => phase.phase === "connecting" || phase.phase === "live";

/** The pill while talking: who speaks, and how loud the user is; then briefly what went wrong. */
export function personaGlance(phase: Phase, since: number, now: number): Glance | null {
  switch (phase.phase) {
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
    case "connecting":
      return "Connecting to PersonaPlex…";
    case "live":
      return phase.said ? `“${phase.said}”` : "Listening… say hello.";
    case "error":
      return phase.message;
  }
}

/** Full-duplex speech-to-speech conversation with NVIDIA PersonaPlex, on a server the user runs. */
export const persona = definePlugin({
  id: "persona",
  label: "Conversation",
  description: "Talk with NVIDIA PersonaPlex, both at once, like on a call.",
  icon: TALK,
  slots: ["glance", "tab"],
  options: {
    // These are drawn by the settings panel: the engine (the server below, or an AI provider
    // whose address and token it uses instead), and the server's address.
    ...engineOptions(),
    server: { ...serverField, inPanel: true },
    voice: choice("Voice", DEFAULT_VOICE, VOICES.map((v) => [v, voiceName(v)] as const)),
    prompt: text("Persona", DEFAULT_PROMPT, {
      multiline: true,
      hint: "Who it plays: its role, its manner, what it knows. Taken at the start of each conversation; it uses dictation's microphone.",
      maxLength: 2000,
    }),
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
  settingsPanel(root, { providers }: { persona: PersonaPort; providers: ProvidersPort }, host) {
    const input = h("input", { class: "path-input", type: "text", spellcheck: "false", placeholder: DEFAULT_SERVER, "aria-label": "PersonaPlex server" });
    input.value = host.options().server;
    const problem = h("p", { class: "field-hint" });
    const hint = h("p", { class: "field-hint" }, SERVER_HINT);
    const serverRow = row("PersonaPlex server", h("div", {}, input, problem, hint));
    // Saved once it reads as an address; until then, what's wrong shows under it.
    input.addEventListener("change", () => {
      const value = (input.value = input.value.trim());
      const wrong = textProblem(serverField, value);
      problem.textContent = wrong ?? "";
      problem.hidden = !wrong;
      if (!wrong) host.setOptions({ server: value });
    });
    problem.hidden = true;
    const engine = enginePanel(providers, host, "s2s", (local) => void (serverRow.hidden = !local), OWN_SERVER);
    root.append(engine.el, serverRow);
    return () => engine.stop();
  },
  setup({ persona: port }: { persona: PersonaPort }, host) {
    let phase: Phase = { phase: "idle" };
    let since = 0;

    let mainIcon = TALK;
    const main = button(icon(TALK), () => void port.control("toggle").catch(() => {}), { class: "round primary dict-main", "aria-label": "Start talking" });
    const status = h("p", { class: "dict-status" });
    const level = h("div", { class: "bar thin dict-level" }, h("i"));
    const settings = button("Settings", () => host.openSettings(), { class: "chip" });

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

    return {
      panel: (root) => root.append(h("div", { class: "dictation" }, h("div", { class: "dict-head" }, main, h("div", { class: "dict-now" }, status, level), settings))),
      glance: (now) => personaGlance(phase, since, now),
    };
  },
});
