import "./greetings.css";
import type { Greeting } from "../../sdk/greeting";
import { boing } from "./boing";
import { hello } from "./hello";
import { sparkle } from "./sparkle";
import { typewriter } from "./typewriter";

/** The built-in startup animations, the default first. Plugins from the plugins folder can add more. */
export const greetings: readonly Greeting[] = [hello, boing, sparkle, typewriter];
