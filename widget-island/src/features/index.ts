import type { Fields } from "../sdk/options";
import type { Plugin } from "../sdk/plugin";
import type { Services } from "./services";
import { clipboard } from "./clipboard";
import { clock } from "./clock";
import { dictation } from "./dictation";
import { media } from "./media";
import { privacy } from "./privacy";
import { screenshot } from "./screenshot";
import { stats } from "./stats";
import { timer } from "./timer";
import { volume } from "./volume";

/** Every plugin the app knows about. Where each shows up is chosen in Settings (defaults in `layout.ts`). */
export const catalogue: readonly Plugin<Services, Fields>[] = [clock, timer, clipboard, stats, media, volume, privacy, screenshot, dictation];

/**
 * What plugins from the plugins folder may use: their ids can't clash with a built-in feature's, and
 * they may only ask for these services. Clipboard history, screen captures and dictation stay
 * with the built-in features: they read what the user copies, sees and says.
 */
export const extensionRules = {
  taken: new Set(catalogue.map((p) => p.id)),
  services: ["stats", "media", "volume", "privacy"] satisfies (keyof Services)[],
} as const;
