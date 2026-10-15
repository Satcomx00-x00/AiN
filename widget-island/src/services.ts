import { type ClipboardPort, tauriClipboard } from "./plugins/clipboard/api";
import { type DictationPort, tauriDictation } from "./plugins/dictation/api";
import { type MediaPort, tauriMedia } from "./plugins/media/api";
import { type PrivacyPort, tauriPrivacy } from "./plugins/privacy/api";
import { type ScreenPort, tauriScreen } from "./plugins/screenshot/api";
import { type StatsPort, tauriStats } from "./plugins/stats/api";
import { type VolumePort, tauriVolume } from "./plugins/volume/api";

/** Backend services plugins may ask for; each plugin's `setup` picks only the ones it needs. */
export interface Services {
  readonly stats: StatsPort;
  readonly clipboard: ClipboardPort;
  readonly media: MediaPort;
  readonly volume: VolumePort;
  readonly privacy: PrivacyPort;
  readonly screen: ScreenPort;
  readonly dictation: DictationPort;
}

export const tauriServices: Services = {
  stats: tauriStats,
  clipboard: tauriClipboard,
  media: tauriMedia,
  volume: tauriVolume,
  privacy: tauriPrivacy,
  screen: tauriScreen,
  dictation: tauriDictation,
};
