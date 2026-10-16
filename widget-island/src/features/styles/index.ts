import type { AnyStyle } from "../../sdk/style";
import { hidden, pill } from "./pill";

/**
 * The built-in pill styles, the default first; each comes in every pill size (low profile, normal,
 * large). Plugins from the plugins folder can add more.
 */
export const styles: readonly AnyStyle[] = [pill, hidden];
