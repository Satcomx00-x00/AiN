import "./popup.css";
import { type PopupPort, idlePopup, tauriPopup } from "../../commands";
import { h } from "../../../sdk/dom";
import { memorySettings, tauriSettings } from "../../settings";
import { hostCommands } from "../../surface";
import { layout } from "../../../features/layout";
import { catalogue } from "../../../features";
import { type Services, tauriServices } from "../../../features/services";

// Outside Tauri (the browser preview) there is no backend: nothing to paste into.
const inTauri = "__TAURI_INTERNALS__" in window;
const popup: PopupPort = inTauri ? tauriPopup : idlePopup;

/** In the browser preview, sample clips stand in for the real (private) history. */
const sample: Services = {
  ...tauriServices,
  clipboard: {
    history: async () => {
      const now = Date.now();
      return [
        { text: "https://v2.tauri.app/start/", copiedAt: now - 4_000 },
        { text: "#0A84FF", copiedAt: now - 95_000 },
        { text: "const island = await mount(root, modules);\nexport default island;", copiedAt: now - 12 * 60_000 },
        { text: "hello@example.com", copiedAt: now - 3 * 3_600_000 },
        { text: "Ship the island widget before Friday, then polish the timer ring and the settings page.", copiedAt: now - 26 * 3_600_000 },
        { text: "42 500,00", copiedAt: now - 50 * 3_600_000 },
      ];
    },
    copy: async () => {},
    copyImage: async () => {},
    clear: async () => {},
  },
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
