import "./styles.css";
import type { AnyStyle } from "../../sdk/style";
import { hidden, pill } from "./pill";
import { sliver } from "./sliver";
import { solo } from "./solo";
import { stub } from "./stub";

/**
 * The built-in pill styles, the default first; each comes in every pill size (low profile, normal,
 * large). Plugins from the plugins folder can add more.
 */
export const styles: readonly AnyStyle[] = [pill, solo, stub, sliver, hidden];
