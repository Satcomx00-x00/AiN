import type { Fields } from "../sdk/options";
import type { Plugin } from "../sdk/plugin";
import type { Services } from "./services";
import { clipboard } from "./clipboard";
import { clock } from "./clock";
import { dictation } from "./dictation";
import { greetings } from "./greetings";
import { media } from "./media";
import { palette } from "./palette";
import { persona } from "./persona";
import { privacy } from "./privacy";
import { screenshot } from "./screenshot";
import { spelling } from "./spelling";
import { stats } from "./stats";
import { styles } from "./styles";
import { timer } from "./timer";
import { transcript } from "./transcript";
import { tts } from "./tts";
import { volume } from "./volume";
import { zones } from "./zones";

/** Every plugin the app knows about. Where each shows up is chosen in Settings (defaults in `layout.ts`). */
export const catalogue: readonly Plugin<Services, Fields>[] = [clock, timer, clipboard, stats, media, volume, privacy, screenshot, dictation, transcript, tts, spelling, persona, palette, zones];

/**
 * What plugins from the plugins folder may use: their ids can't clash with a built-in feature's,
 * startup animation's or pill style's, and
 * they may only ask for these services (`oauth` bound to each plugin's id). Clipboard history, screen captures, dictation,
 * transcript, read aloud, spelling, conversation and the palette's apps and files stay with the built-in features: they
 * read what the user copies, sees, says, hears and selects, and start programs.
 */
export const extensionRules = {
  taken: new Set([...catalogue.map((p) => p.id), ...greetings.map((g) => g.id), ...styles.map((s) => s.id)]),
  services: ["stats", "media", "volume", "privacy", "oauth"] satisfies (keyof Services)[],
} as const;
