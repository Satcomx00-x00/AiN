import { type App, type Hit, type SystemAction, commands } from "./bindings";

export type { App, Hit, SystemAction };

/** What the command palette asks of the system. */
export interface PalettePort {
  /** The installed apps. */
  apps(): Promise<App[]>;
  launch(id: string): Promise<void>;
  /** Files and folders whose name has every word of `query`, best first. */
  files(query: string, limit: number): Promise<Hit[]>;
  /** What a path being typed points at: the entries of its folder starting with its last part. */
  browse(path: string, limit: number): Promise<Hit[]>;
  /** Opens a file or a folder with its default app. */
  open(path: string): Promise<void>;
  /** Shows a file selected in its folder. */
  reveal(path: string): Promise<void>;
  /** Runs a command line in a new terminal window. */
  run(command: string): Promise<void>;
  system(action: SystemAction): Promise<void>;
  /** Opens an https link in the default browser. */
  openUrl(url: string): Promise<void>;
}

export const tauriPalette: PalettePort = {
  apps: () => commands.apps(),
  launch: async (id) => void (await commands.launch(id)),
  files: (query, limit) => commands.files(query, limit),
  browse: (path, limit) => commands.browse(path, limit),
  open: async (path) => void (await commands.open(path)),
  reveal: async (path) => void (await commands.reveal(path)),
  run: async (command) => void (await commands.run(command)),
  system: async (action) => void (await commands.system(action)),
  openUrl: async (url) => void (await commands.openUrl(url)),
};

/** Nothing installed and nothing found, doing nothing: for the browser previews. */
export const idlePalette: PalettePort = {
  apps: async () => [],
  launch: async () => {},
  files: async () => [],
  browse: async () => [],
  open: async () => {},
  reveal: async () => {},
  run: async () => {},
  system: async () => {},
  openUrl: async () => {},
};
