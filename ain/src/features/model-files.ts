/**
 * The parts shared by the features that run a downloaded model on this computer (dictation, read
 * aloud): the model is chosen, downloaded and removed in Settings, and the island only shows it.
 */
import { button, h } from "../sdk/dom";
import { toggle } from "../sdk/options";

/** The "keepLoaded" option: the chosen model stays in memory, ready at once, alongside the other features' models. */
export const keepLoaded = () => toggle("Keep the model loaded", false, "Ready at once, at the cost of its memory; otherwise it is let go after 10 minutes unused.");

/** A model's status, as the backend reports it. */
export type ModelState = { state: "missing"; size: number } | { state: "downloading"; received: number; total: number } | { state: "ready" } | { state: "error"; message: string };

/** The chosen model, the folder it is (or would be) stored in, and which models are downloaded. */
export type ModelInfo = { readonly model: string; readonly dir: string; readonly installed: readonly string[] } & ModelState;

/** What the model files row asks of the backend. */
export interface ModelFilesPort {
  download(): Promise<void>;
  /** Stops a download in progress, or deletes the downloaded model. */
  remove(): Promise<void>;
  openFolder(): Promise<void>;
}

export const mb = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`;

/** A download's size: in MB, or GB from 1 GB on (the conversation model is about 17). */
export const size = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : mb(bytes));

/** How far a download is (0–1), from what was received of the total; 0 while the total is unknown. */
export const progressOf = (received: number, total: number): number => (total ? Math.min(received / total, 1) : 0);

/** What a download says: how much was received of how much, once the total is known. */
export const downloading = (received: number, total: number): string => (total ? `Downloading… ${size(received)} of ${size(total)}` : "Downloading…");

/** What the island's tab says about the chosen model (`name`): read-only, since it is managed in Settings. */
export function modelLine(name: string, info: ModelState): { title: string; detail: string; progress: number | null } {
  switch (info.state) {
    case "missing":
      return { title: name, detail: "Not downloaded yet", progress: null };
    case "downloading":
      return { title: name, detail: downloading(info.received, info.total), progress: progressOf(info.received, info.total) };
    case "ready":
      return { title: name, detail: "Ready", progress: null };
    case "error":
      return { title: name, detail: `Download failed: ${info.message}`, progress: null };
  }
}

/** What Settings says about the chosen model, and what its button does there. */
export function modelSetup(info: ModelState): { detail: string; action: "download" | "stop" | "remove"; label: string; progress: number | null } {
  switch (info.state) {
    case "missing":
      return { detail: "Not downloaded", action: "download", label: `Download · ${size(info.size)}`, progress: null };
    case "downloading":
      return { detail: downloading(info.received, info.total), action: "stop", label: "Stop", progress: progressOf(info.received, info.total) };
    case "ready":
      return { detail: "Downloaded", action: "remove", label: "Remove", progress: null };
    case "error":
      return { detail: `Download failed: ${info.message}`, action: "download", label: "Retry", progress: null };
  }
}

/** A Settings row: a label, and the control (e.g. a model drop-down) under it. */
export const fieldRow = (label: string, control: HTMLElement): HTMLElement =>
  h("div", { class: "field wide" }, h("div", {}, h("div", { class: "field-label" }, label)), control);

/** Settings' "Model files" row: the model's state and folder, and the buttons to show, download, stop or remove it. */
export function modelFiles(port: ModelFilesPort): { readonly el: HTMLElement; draw(info: ModelInfo): void } {
  let model: ModelInfo | null = null;
  const detail = h("div", { class: "field-hint" });
  const bar = h("div", { class: "progress" }, h("i"));
  const action = button("", () => {
    const setup = model && modelSetup(model);
    const run = setup?.action === "download" ? port.download() : setup ? port.remove() : null;
    run?.catch((e: unknown) => (detail.textContent = String(e)));
  }, { class: "secondary" });
  const folder = button("Show folder", () => void port.openFolder().catch(() => {}), { class: "secondary" });
  const el = h("div", { class: "field" }, h("div", {}, h("div", { class: "field-label" }, "Model files"), detail, bar), h("div", { class: "recorder" }, folder, action));
  const draw = (info: ModelInfo) => {
    model = info;
    const setup = modelSetup(info);
    detail.textContent = setup.detail;
    detail.title = info.dir;
    bar.hidden = setup.progress === null;
    bar.style.setProperty("--p", String(setup.progress ?? 0));
    action.textContent = setup.label;
    action.classList.toggle("danger", setup.action === "remove");
  };
  return { el, draw };
}

/** A line of the island's model card, and the state it is in: ready (nothing to set up), downloading (Settings can stop it), or another. */
export type CardLine = { title: string; detail: string; progress: number | null; state: string; dir: string };

/** The island's card for the chosen model, read-only, with a way to Settings until it is ready; `show` draws any line on it. */
export function modelCard(openSettings: () => void): { readonly el: HTMLElement; draw(name: string, info: ModelInfo): void; show(line: CardLine): void } {
  const title = h("strong");
  const detail = h("span", { class: "muted" });
  const bar = h("div", { class: "bar thin" }, h("i"));
  const setUp = button("Set up in Settings", openSettings, { class: "chip" });
  const el = h("div", { class: "dict-model" }, h("div", { class: "dict-model-text" }, title, detail, bar), setUp);
  const show = (line: CardLine) => {
    title.textContent = line.title;
    detail.textContent = line.detail;
    detail.title = line.dir;
    bar.hidden = line.progress === null;
    bar.style.setProperty("--p", String(line.progress ?? 0));
    el.dataset.state = line.state;
    // Ready, there's nothing to set up; while downloading, Settings is where it can be stopped.
    setUp.hidden = line.state === "ready";
    setUp.textContent = line.state === "downloading" ? "Settings" : "Set up in Settings";
  };
  const draw = (name: string, info: ModelInfo) => show({ ...modelLine(name, info), state: info.state, dir: info.dir });
  return { el, draw, show };
}
