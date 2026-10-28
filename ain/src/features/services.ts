import { type ClipboardPort, tauriClipboard } from "./clipboard/service";
import { type DictationPort, tauriDictation } from "./dictation/service";
import { type MediaPort, tauriMedia } from "./media/service";
import { type NotificationsPort, centerPort } from "./notifications/service";
import { type PersonaPort, tauriPersona } from "./persona/service";
import { type PrivacyPort, tauriPrivacy } from "./privacy/service";
import { type CapturePort, tauriCapture } from "./screenshot/service";
import { type SpellingPort, tauriSpelling } from "./spelling/service";
import { type StatsPort, tauriStats } from "./stats/service";
import { type TranscriptPort, tauriTranscript } from "./transcript/service";
import { type TtsPort, tauriTts } from "./tts/service";
import { type VolumePort, tauriVolume } from "./volume/service";
import type { PerPlugin } from "../shell/extensions";
import { type OAuthPort, tauriOAuth } from "../shell/oauth";
import { type AiPort, tauriAi } from "../shell/ai";
import { type ProvidersPort, settingsProviders } from "../shell/providers";
import { center } from "../shell/notifications";
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
  readonly tts: TtsPort;
  readonly transcript: TranscriptPort;
  readonly persona: PersonaPort;
  readonly spelling: SpellingPort;
  /** Signing in to online accounts; each plugin gets its own, bound to its id. */
  readonly oauth: PerPlugin<OAuthPort>;
  /** The AI providers set up in Settings, which AI features may run on instead of their own model. */
  readonly providers: ProvidersPort;
  /** The notification history (the island's notification center). */
  readonly notifications: NotificationsPort;
  /** Asking the AI model the user picked for plugins (Settings → AI providers). */
  readonly ai: AiPort;
}

/** The island's notification center: plugins post to it, the island shows what it says to. */
export const notificationCenter = center();

export const tauriServices: Services = {
  stats: tauriStats,
  clipboard: tauriClipboard,
  media: tauriMedia,
  volume: tauriVolume,
  privacy: tauriPrivacy,
  capture: tauriCapture,
  dictation: tauriDictation,
  tts: tauriTts,
  transcript: tauriTranscript,
  persona: tauriPersona,
  spelling: tauriSpelling,
  oauth: tauriOAuth,
  providers: settingsProviders(tauriSettings.watch),
  notifications: centerPort(notificationCenter),
  ai: tauriAi,
};
