import "./popup.css";
import { type PopupPort, idlePopup, tauriPopup } from "../../commands";
import { h } from "../../../sdk/dom";
import { memorySettings, tauriSettings } from "../../settings";
import { hostCommands } from "../../surface";
import { layout } from "../../../features/layout";
import { catalogue } from "../../../features";
import { type Services, tauriServices } from "../../../features/services";
import { memoryClipboard } from "../../../features/clipboard/service";

// Outside Tauri (the browser preview) there is no backend: nothing to paste into.
const inTauri = "__TAURI_INTERNALS__" in window;
const popup: PopupPort = inTauri ? tauriPopup : idlePopup;

/** In the browser preview, sample clips stand in for the real (private) history. */
const sample: Services = {
  ...tauriServices,
  clipboard: memoryClipboard(
    [
      "https://v2.tauri.app/start/",
      "#0A84FF",
      "const island = await mount(root, modules);\nexport default island;",
      "hello@example.com",
      "Ship the island widget before Friday, then polish the timer ring and the settings page.",
      "42 500,00",
    ].map((text, i) => ({ id: i + 1, text, image: null, copiedAt: Date.now() - [4, 95, 720, 10_800, 93_600, 180_000][i]! * 1000 })),
  ),
};

const sheet = h("div", { class: "sheet" });
document.body.append(sheet);
hostCommands({
  container: sheet,
  catalogue,
  layout,
  services: inTauri ? tauriServices : sample,
  popup,
  store: inTauri ? tauriSettings : memorySettings(),
});
