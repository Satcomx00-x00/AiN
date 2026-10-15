/**
 * The island's plugin API. Built-in features import these modules directly; a plugin from the
 * plugins folder receives the same things as one object, since it is loaded on its own:
 *
 * ```js
 * export default (island) => island.definePlugin({ id: "hello", … });
 * ```
 *
 * Bump `version` on any change that could break such a plugin.
 */
import * as chart from "./chart";
import * as color from "./color";
import * as dom from "./dom";
import { choice, folder, list, number, text, toggle } from "./options";
import { definePlugin } from "./plugin";
import { select } from "./select";

export const sdk = Object.freeze({
  version: 1,
  definePlugin,
  options: Object.freeze({ toggle, number, choice, list, folder, text }),
  dom: Object.freeze({ ...dom }),
  chart: Object.freeze({ ...chart }),
  color: Object.freeze({ ...color }),
  /** Components styled like the island: `select`, a drop-down list. */
  ui: Object.freeze({ select }),
});

export type Sdk = typeof sdk;
