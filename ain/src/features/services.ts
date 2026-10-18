import { type ClipboardPort, tauriClipboard } from "./clipboard/service";
import { type DictationPort, tauriDictation } from "./dictation/service";
import { type MediaPort, tauriMedia } from "./media/service";
import { type PrivacyPort, tauriPrivacy } from "./privacy/service";
import { type CapturePort, tauriCapture } from "./screenshot/service";
import { type StatsPort, tauriStats } from "./stats/service";
import { type VolumePort, tauriVolume } from "./volume/service";
import type { PerPlugin } from "../shell/extensions";
import { type OAuthPort, tauriOAuth } from "../shell/oauth";

/** Backend services plugins may ask for; each plugin's `setup` picks only the ones it needs. */
export interface Services {
  readonly stats: StatsPort;
  readonly clipboard: ClipboardPort;
  readonly media: MediaPort;
  readonly volume: VolumePort;
  readonly privacy: PrivacyPort;
  readonly capture: CapturePort;
  readonly dictation: DictationPort;
  /** Signing in to online accounts; each plugin gets its own, bound to its id. */
  readonly oauth: PerPlugin<OAuthPort>;
}

export const tauriServices: Services = {
  stats: tauriStats,
  clipboard: tauriClipboard,
  media: tauriMedia,
  volume: tauriVolume,
  privacy: tauriPrivacy,
  capture: tauriCapture,
  dictation: tauriDictation,
  oauth: tauriOAuth,
};
