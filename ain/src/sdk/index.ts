/**
 * The island's plugin API. Built-in features import these modules directly; a plugin from the
 * plugins folder receives the same things as one object, since it is loaded on its own:
 *
 * ```js
 * export default (island) => island.definePlugin({ id: "hello", … });
 * // or a startup animation:
 * export default (island) => island.defineGreeting({ id: "wave", label: "Wave", play(stage) { … } });
 * // or a pill style:
 * export default (island) => island.defineStyle({ id: "neon", label: "Neon", mount(root, ctx) { … } });
 * ```
 *
 * Bump `version` on any change that could break such a plugin.
 */
import * as chart from "./chart";
import * as color from "./color";
import * as dom from "./dom";
import { defineGreeting, settle } from "./greeting";
import { choice, folder, list, number, text, toggle } from "./options";
import { glanceSlot } from "./glance";
import { definePlugin } from "./plugin";
import { select } from "./select";
import { defineStyle } from "./style";

export const sdk = Object.freeze({
  version: 1,
  definePlugin,
  defineGreeting,
  defineStyle,
  /** Waits for Web Animations to end; a cancelled one counts as ended. */
  settle,
  options: Object.freeze({ toggle, number, choice, list, folder, text }),
  dom: Object.freeze({ ...dom }),
  chart: Object.freeze({ ...chart }),
  color: Object.freeze({ ...color }),
  /**
   * Components styled like the island: `select`, a drop-down list, and `glanceSlot`, a glance spot
   * drawn as on the Pill (for styles).
   */
  ui: Object.freeze({ select, glanceSlot }),
});

export type Sdk = typeof sdk;
