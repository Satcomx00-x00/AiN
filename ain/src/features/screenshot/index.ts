import { toggle } from "../../sdk/options";
import { primaryKey } from "../../sdk/platform";
import { definePlugin } from "../../sdk/plugin";
import type { ClipboardPort } from "../clipboard/service";
import type { CapturePort } from "./service";
import { editor } from "./editor";

const CAMERA = `<path d="M2.5 5.5a1 1 0 0 1 1-1h2l1-1.5h3l1 1.5h2a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><circle cx="8" cy="8.5" r="2.25"/>`;

/** Screenshots you can draw on; Ctrl+C puts the result on the clipboard. A tool only: no tab, no glance. */
export const screenshot = definePlugin({
  id: "screenshot",
  label: "Screenshot",
  description: "Capture and annotate the screen.",
  icon: CAMERA,
  slots: [],
  options: {
    closeAfterCopy: toggle("Close after copying", true),
  },
  commands: [
    {
      id: "capture",
      label: "Annotate a screenshot",
      description: `${primaryKey()}+C to copy, ${primaryKey()}+S to save.`,
      // Win+Shift+S belongs to the Windows Snipping Tool.
      shortcut: "Super+Alt+KeyS",
      surface: "screen",
      popup: editor,
    },
  ],
  setup: (_: { capture: CapturePort; clipboard: ClipboardPort }) => ({}),
});
