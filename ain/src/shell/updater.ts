import { type Report, type State, commands, events } from "./bindings/updates";

export type { Report, State };

export interface UpdaterPort {
  /** Where the updater stands now. */
  status(): Promise<Report>;
  /** Checks for a newer version; resolves with the outcome. */
  check(): Promise<Report>;
  /** Downloads and installs the update found, then restarts the app. */
  install(): Promise<void>;
  /** Opens the releases page in the browser. */
  openReleases(): Promise<void>;
  /** Calls `on` at every change (download progress included); resolves to a stop function. */
  watch(on: (report: Report) => void): Promise<() => void>;
}

export const tauriUpdater: UpdaterPort = {
  status: () => commands.status(),
  check: () => commands.check(),
  install: async () => void (await commands.install()),
  openReleases: async () => void (await commands.openReleases()),
  watch: (on) => events.updateChanged.listen((e) => on(e.payload)),
};

/**
 * A pretend updater for the browser preview: a check finds 0.2.0, an install "downloads" it in a
 * few seconds, so every state of the Updates card can be looked at outside the app.
 */
export function demoUpdater(): UpdaterPort {
  const listeners = new Set<(r: Report) => void>();
  let report: Report = { current: "0.1.0", state: { kind: "idle" }, releases: "https://github.com/" };
  const set = (state: State) => {
    report = { ...report, state };
    for (const on of listeners) on(report);
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const notes = "### Features\n- A new widget\n- Faster startup\n\n### Bug fixes\n- The pill no longer flickers on wake";
  return {
    status: async () => report,
    check: async () => {
      set({ kind: "checking" });
      await wait(900);
      set({ kind: "available", version: "0.2.0", notes });
      return report;
    },
    install: async () => {
      const total = 8_862_084;
      for (let received = 0; received < total; received += 443_104) {
        set({ kind: "downloading", version: "0.2.0", received, total });
        await wait(120);
      }
      set({ kind: "installing", version: "0.2.0" });
    },
    openReleases: async () => {},
    watch: async (on) => {
      listeners.add(on);
      return () => listeners.delete(on);
    },
  };
}

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** How a state looks: a tone for its icon and badge. */
export type Tone = "ok" | "accent" | "busy" | "hot" | "muted";

export interface View {
  /** One sentence under the version. */
  readonly text: string;
  /** Short label for the badge, or null for none. */
  readonly badge: string | null;
  readonly tone: Tone;
  /** The one action offered. */
  readonly action: "check" | "install" | null;
  /** Download progress, 0–1, or null when there is no bar to show. */
  readonly progress: number | null;
}

/** What the Updates card shows for a state. */
export function describe(state: State): View {
  const view = (text: string, tone: Tone, badge: string | null, action: View["action"], progress: number | null = null): View => ({ text, tone, badge, action, progress });
  switch (state.kind) {
    case "disabled":
      return view(state.reason, "muted", "Off", null);
    case "idle":
      return view("Not checked yet.", "muted", null, "check");
    case "checking":
      return view("Checking for updates…", "busy", "Checking", null);
    case "upToDate":
      return view("You're on the latest version.", "ok", "Up to date", "check");
    case "available":
      return view(`Version ${state.version} is ready to install.`, "accent", "Update available", "install");
    case "downloading": {
      const of = state.total ? ` of ${mb(state.total)} MB` : " MB";
      const ratio = state.total ? Math.min(state.received / state.total, 1) : null;
      const percent = ratio === null ? "" : ` · ${Math.floor(ratio * 100)}%`;
      return view(`Downloading ${state.version} — ${mb(state.received)}${of}${percent}`, "busy", "Downloading", null, ratio ?? 0);
    }
    case "installing":
      return view(`Installing ${state.version}. AiN will restart by itself.`, "busy", "Installing", null, 1);
    case "failed":
      return view(state.message, "hot", "Failed", "check");
  }
}

/** Release notes as plain lines: Markdown headings and bullets without their markers, blank runs collapsed. */
export function noteLines(notes: string): { text: string; heading: boolean }[] {
  return notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .map((line) => {
      const heading = /^#{1,6}\s/.test(line);
      return { text: line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "• "), heading };
    })
    .filter((line, i, all) => !(line.text === "" && (i === 0 || i === all.length - 1)));
}
