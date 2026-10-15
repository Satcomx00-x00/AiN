import { type ClipboardPort, tauriClipboard } from "./clipboard/service";
import { type DictationPort, tauriDictation } from "./dictation/service";
import { type MediaPort, tauriMedia } from "./media/service";
import { type PrivacyPort, tauriPrivacy } from "./privacy/service";
import { type CapturePort, tauriCapture } from "./screenshot/service";
import { type StatsPort, tauriStats } from "./stats/service";
import { type VolumePort, tauriVolume } from "./volume/service";

/** Backend services plugins may ask for; each plugin's `setup` picks only the ones it needs. */
export interface Services {
  readonly stats: StatsPort;
  readonly clipboard: ClipboardPort;
  readonly media: MediaPort;
  readonly volume: VolumePort;
  readonly privacy: PrivacyPort;
  readonly capture: CapturePort;
  readonly dictation: DictationPort;
}

export const tauriServices: Services = {
  stats: tauriStats,
  clipboard: tauriClipboard,
  media: tauriMedia,
  volume: tauriVolume,
  privacy: tauriPrivacy,
  capture: tauriCapture,
  dictation: tauriDictation,
};
