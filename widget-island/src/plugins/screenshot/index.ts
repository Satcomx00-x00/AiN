import { toggle } from "../../core/options";
import { definePlugin } from "../../core/plugin";
import type { ClipboardPort } from "../clipboard/api";
import type { ScreenPort } from "./api";
import { editor } from "./editor";

const CAMERA = `<path d="M2.5 5.5a1 1 0 0 1 1-1h2l1-1.5h3l1 1.5h2a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><circle cx="8" cy="8.5" r="2.25"/>`;

/** Screenshots you can draw on; Ctrl+C puts the result on the clipboard. A tool only: no tab, no glance. */
export const screenshot = definePlugin({
  id: "screenshot",
  label: "Screenshot",
  description: "Capture the screen, draw on it with crayons, then Ctrl+C to copy or Ctrl+S to save.",
  icon: CAMERA,
  slots: [],
  options: {
    closeAfterCopy: toggle("Close after copying", true, "Ctrl+C copies the image and closes the editor."),
  },
  commands: [
    {
      id: "capture",
      label: "Annotate a screenshot",
      description: "Freezes the screen under the pointer so you can draw on it, select an area and copy it.",
      // Win+Shift+S belongs to the Windows Snipping Tool.
      shortcut: "Super+Alt+KeyS",
      surface: "screen",
      popup: editor,
    },
  ],
  setup: (_: { screen: ScreenPort; clipboard: ClipboardPort }) => ({}),
});
