import { start } from "./app";
import { tauriSettings } from "../../settings";

// Right-click opens settings instead of the browser's context menu.
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  tauriSettings.open().catch((err: unknown) => console.error("[island] could not open settings", err));
});

const root = document.querySelector<HTMLElement>("#island");
if (root) start(root).catch((e: unknown) => console.error("[island] failed to start", e));
