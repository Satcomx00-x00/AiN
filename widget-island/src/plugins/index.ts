import type { Fields } from "../core/options";
import type { Plugin } from "../core/plugin";
import type { Services } from "../services";
import { clipboard } from "./clipboard";
import { clock } from "./clock";
import { media } from "./media";
import { privacy } from "./privacy";
import { screenshot } from "./screenshot";
import { stats } from "./stats";
import { timer } from "./timer";
import { volume } from "./volume";

/** Every plugin the app knows about. Where each shows up is chosen in Settings (defaults in `layout.ts`). */
export const catalogue: readonly Plugin<Services, Fields>[] = [clock, timer, clipboard, stats, media, volume, privacy, screenshot];
