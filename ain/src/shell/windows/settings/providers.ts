/**
 * Settings → AI providers: the online services and OpenAI-compatible servers every AI feature may
 * use instead of its model on this computer, each with its address and how it authenticates.
 */
import { button, h, icon } from "../../../sdk/dom";
import { select } from "../../../sdk/select";
import { type AiProvider, type Auth, PRESETS, type ProvidersPort, newProvider, presetById, providerProblem } from "../../providers";
import { field, flag, segmented } from "./controls";

export const PROVIDERS_ICON = `<path d="M8 1.75 13.5 4.9v6.2L8 14.25 2.5 11.1V4.9z"/><path d="M2.5 4.9 8 8l5.5-3.1M8 8v6.25"/>`;

const AUTH_CHOICES = [
  { value: "none", label: "None" },
  { value: "env", label: "Variable" },
  { value: "file", label: "File" },
] as const;

/** What the section needs from the Settings page. */
export interface ProvidersSection {
  /** The providers as saved now. */
  providers(): readonly AiProvider[];
  /** Saves the list; `redraw` rebuilds the section (after adding or removing one). */
  save(next: readonly AiProvider[], redraw?: boolean): void;
  readonly port: Pick<ProvidersPort, "models">;
  /** The system's file picker; null when cancelled. */
  pickFile(current: string): Promise<string | null>;
}

/** The token's way in, kept when switching back and forth: what was typed for the other kind is lost. */
const authOf = (kind: Auth["kind"], was: Auth): Auth =>
  kind === was.kind ? was : kind === "env" ? { kind, name: "" } : kind === "file" ? { kind, path: "" } : { kind };

/** A one-line text box saved on change. */
function textBox(value: string, label: string, placeholder: string, onChange: (v: string) => void): HTMLInputElement {
  const input = h("input", { class: "path-input", type: "text", spellcheck: "false", placeholder, "aria-label": label });
  input.value = value;
  input.addEventListener("change", () => onChange((input.value = input.value.trim())));
  return input;
}

/** "Test connection": lists the provider's models, or says why it can't. */
export const testResult = (models: readonly string[]): string =>
  models.length ? `Connected · ${models.length} model${models.length === 1 ? "" : "s"}: ${models.slice(0, 6).join(", ")}${models.length > 6 ? "…" : ""}` : "Connected, but it lists no models";

function providerCard(at: number, s: ProvidersSection): HTMLElement {
  let p = s.providers()[at]!;
  const update = (patch: Partial<AiProvider>) => {
    p = { ...p, ...patch };
    s.save(s.providers().map((q, i) => (i === at ? p : q)));
    paint();
  };
  const title = h("h2", {}, p.name);
  const name = textBox(p.name, "Name", presetById(p.preset).name, (v) => (v ? update({ name: v }) : (name.value = p.name)));
  const url = textBox(p.baseUrl, "Address", presetById(p.preset).baseUrl, (v) => update({ baseUrl: v }));
  const urlField = field("Address", "The API's root, before /audio/… and /models", url, true);

  const env = textBox(p.auth.kind === "env" ? p.auth.name : "", "Environment variable", "OPENAI_API_KEY", (v) => update({ auth: { kind: "env", name: v } }));
  const path = textBox(p.auth.kind === "file" ? p.auth.path : "", "Token file", "/run/secrets/ai-token", (v) => update({ auth: { kind: "file", path: v } }));
  const browse = button("Browse…", () => {
    s.pickFile(path.value).then((chosen) => chosen && update({ auth: { kind: "file", path: (path.value = chosen) } }), () => {});
  }, { class: "secondary" });
  const envField = field("Variable", "Its value is sent as a bearer token (an API key or a JWT), read again on every request", env, true);
  const fileField = field("File", "Its content is sent as a bearer token (an API key or a JWT), read again on every request", h("div", { class: "path" }, path, browse), true);
  const auth = segmented(p.auth.kind, AUTH_CHOICES, (kind) => update({ auth: authOf(kind as Auth["kind"], p.auth) }), "Authentication");

  const result = h("div", { class: "field-hint", role: "status" });
  const test = button("Test connection", () => {
    result.textContent = "Connecting…";
    s.port.models(p).then((models) => (result.textContent = testResult(models)), (e: unknown) => (result.textContent = e instanceof Error ? e.message : String(e)));
  }, { class: "secondary" });
  const remove = button("Remove", () => s.save(s.providers().filter((_, i) => i !== at), true), { class: "secondary danger" });

  const paint = () => {
    title.textContent = p.name;
    envField.hidden = p.auth.kind !== "env";
    fileField.hidden = p.auth.kind !== "file";
    const problem = providerProblem(p);
    flag(urlField, problem?.startsWith("The address") ? problem : null);
    flag(p.auth.kind === "file" ? fileField : envField, problem && !problem.startsWith("The address") ? problem : null);
    test.disabled = problem !== null;
  };
  paint();

  return h(
    "section",
    { class: "card", id: `card-provider-${p.id}` },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "ico", "aria-hidden": "true" }, icon(PROVIDERS_ICON)),
      h("div", { class: "grow" }, title, h("p", { class: "mono" }, p.id)),
      h("span", { class: "badge" }, presetById(p.preset).name),
    ),
    field("Name", "How the AI features list it", name, true),
    urlField,
    field("Authentication", "None for an open server, else a bearer token", auth),
    envField,
    fileField,
    h("div", { class: "field" }, h("div", {}, h("div", { class: "field-label" }, "Connection"), result), h("div", { class: "recorder" }, test, remove)),
  );
}

export function providersSection(s: ProvidersSection): Node[] {
  let preset: string = PRESETS[0].id;
  const picker = select(
    PRESETS.map((p) => ({ value: p.id, label: p.name, detail: p.baseUrl })),
    preset,
    (id) => (preset = id),
    "Provider",
  );
  const add = button("Add", () => s.save([...s.providers(), newProvider(presetById(preset), s.providers().map((p) => p.id))], true));
  return [
    h("h1", {}, "AI providers"),
    h(
      "p",
      { class: "lead" },
      "Online services, or your own OpenAI-compatible server, that every AI feature can use instead of its model on this computer: pick one in Dictation's or Read aloud's card under Widgets.",
    ),
    ...s.providers().map((_, at) => providerCard(at, s)),
    h("section", { class: "card", id: "card-provider-add" }, field("Add a provider", "A known service, or any server speaking the OpenAI API", h("div", { class: "path" }, picker.el, add), true)),
  ];
}
