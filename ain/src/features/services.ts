import { type ClipboardPort, tauriClipboard } from "./clipboard/service";
import { type DictationPort, tauriDictation } from "./dictation/service";
import { type MediaPort, tauriMedia } from "./media/service";
import { type PalettePort, tauriPalette } from "./palette/service";
import { type PersonaPort, tauriPersona } from "./persona/service";
import { type PrivacyPort, tauriPrivacy } from "./privacy/service";
import { type CapturePort, tauriCapture } from "./screenshot/service";
import { type StatsPort, tauriStats } from "./stats/service";
import { type TranscriptPort, tauriTranscript } from "./transcript/service";
import { type TtsPort, tauriTts } from "./tts/service";
import { type VolumePort, tauriVolume } from "./volume/service";
import { type ZonesPort, tauriZones } from "./zones/service";
import type { PerPlugin } from "../shell/extensions";
import { type OAuthPort, tauriOAuth } from "../shell/oauth";
import { type ProvidersPort, settingsProviders } from "../shell/providers";
import { tauriSettings } from "../shell/settings";

/** Backend services plugins may ask for; each plugin's `setup` picks only the ones it needs. */
export interface Services {
  readonly stats: StatsPort;
  readonly clipboard: ClipboardPort;
  readonly media: MediaPort;
  readonly volume: VolumePort;
  readonly privacy: PrivacyPort;
  readonly capture: CapturePort;
  readonly dictation: DictationPort;
  /** Apps, files and system actions, for the command palette. */
  readonly palette: PalettePort;
  /** Windows snapped into zones: the layout preview and the overlay. */
  readonly zones: ZonesPort;
  readonly tts: TtsPort;
  readonly transcript: TranscriptPort;
  readonly persona: PersonaPort;
  /** Signing in to online accounts; each plugin gets its own, bound to its id. */
  readonly oauth: PerPlugin<OAuthPort>;
  /** The AI providers set up in Settings, which AI features may run on instead of their own model. */
  readonly providers: ProvidersPort;
}

export const tauriServices: Services = {
  stats: tauriStats,
  clipboard: tauriClipboard,
  media: tauriMedia,
  volume: tauriVolume,
  privacy: tauriPrivacy,
  capture: tauriCapture,
  dictation: tauriDictation,
  palette: tauriPalette,
  zones: tauriZones,
  tts: tauriTts,
  transcript: tauriTranscript,
  persona: tauriPersona,
  oauth: tauriOAuth,
  providers: settingsProviders(tauriSettings.watch),
};
