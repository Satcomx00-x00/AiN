import { type PopupPort, idlePopup, tauriPopup } from "../../commands";
import { type CommunityPort, noCommunity, tauriCommunity } from "../../community";
import { type ExtensionsPort, type Importer, importSource, noExtensions, tauriExtensions } from "../../extensions";
import { type SettingsPort, memorySettings, tauriSettings } from "../../settings";
import { type SecretsPort, memorySecrets, tauriSecrets } from "../../secrets";
import { type UpdaterPort, demoUpdater, tauriUpdater } from "../../updater";
import { type Services, tauriServices } from "../../../features/services";

/** What the settings page talks to. */
export interface SettingsPorts {
  readonly store: SettingsPort;
  readonly popup: PopupPort;
  readonly folder: ExtensionsPort;
  readonly importer: Importer;
  /** The community plugin store; without it (e.g. in a test), the Plugins section shows none. */
  readonly community?: CommunityPort;
  /** Self-update; without it (e.g. in a test), a pretend one that shows every state and never touches the network. */
  readonly updater?: UpdaterPort;
  /** Plugins' secrets; without it (e.g. in a test), kept in memory. */
  readonly secrets?: SecretsPort;
  /** What plugins' settings panels and pages are given; without it, the app's. */
  readonly services?: Services;
  /** True inside the app: shortcuts can be tried, folders picked and plugins set up with real services. */
  readonly inApp: boolean;
}

/** The app's backend inside Tauri; in the browser preview, settings live in memory and there are no shortcuts. */
export function appPorts(): SettingsPorts {
  const inApp = "__TAURI_INTERNALS__" in window;
  return {
    store: inApp ? tauriSettings : memorySettings(),
    popup: inApp ? tauriPopup : idlePopup,
    folder: inApp ? tauriExtensions : noExtensions,
    importer: importSource,
    community: inApp ? tauriCommunity : noCommunity,
    updater: inApp ? tauriUpdater : demoUpdater(),
    secrets: inApp ? tauriSecrets : memorySecrets(),
    services: tauriServices,
    inApp,
  };
}

let given: SettingsPorts | undefined;

/** Runs the settings page against other ports, e.g. the island's in an integration test. Call before the page loads. */
export const usePorts = (ports: SettingsPorts | undefined): void => void (given = ports);

/** The ports the page uses: those given with `usePorts`, else the app's. */
export const settingsPorts = (): SettingsPorts => given ?? appPorts();
