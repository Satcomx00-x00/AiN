import { choice, list, toggle } from "../../sdk/options";
import { isMac } from "../../sdk/platform";
import { definePlugin } from "../../sdk/plugin";
import type { ClipboardPort } from "../clipboard/service";
import { ENGINES } from "./providers";
import type { PalettePort } from "./service";
import { paletteView } from "./view";

const ICON = `<rect x="2" y="2.75" width="12" height="10.5" rx="2.25"/><path d="M4.75 6.25 6.75 8l-2 1.75M8.5 9.75h2.75"/>`;

/**
 * One shortcut to start apps, open files, calculate, search the web, run a command line, lock or
 * shut down the computer, and run the app's own commands. A tool only: no tab, no glance.
 */
export const palette = definePlugin({
  id: "palette",
  label: "Command palette",
  description: "Apps, files, calculations and commands, from one shortcut.",
  icon: ICON,
  slots: [],
  options: {
    files: toggle("Search files", true, "By name, in your home folder a few levels deep; hidden and generated folders are left out."),
    folders: list("Also search in", [], "A folder, e.g. ~/Projects", "Folders outside your home folder, searched the same way."),
    engine: choice(
      "Web search",
      "duckduckgo",
      Object.entries(ENGINES).map(([id, e]) => [id, e.label] as const),
    ),
    confirm: toggle("Ask before signing out, restarting or shutting down", true),
  },
  commands: [
    {
      id: "open",
      label: "Command palette",
      description: "> runs a command line, ? searches the web, = calculates.",
      // Option+Space, as launchers use on macOS (Cmd+Space is Spotlight's); Win+Alt+Space elsewhere.
      shortcut: isMac() ? "Alt+Space" : "Super+Alt+Space",
      popup: paletteView,
    },
  ],
  setup: (_: { palette: PalettePort; clipboard: ClipboardPort }) => ({}),
});
