import type { Fields, Values } from "./options";
import type { Glance } from "./plugin";

/** The pill sizes picked in Settings → Appearance. */
export type PillSize = "low" | "normal" | "large";

/** The folded pill at the chosen size: what a style starts from. */
export interface Pill {
  readonly width: number;
  readonly height: number;
  /** A hardware notch sets the height; the width leaves room for glances beside it. */
  readonly hasNotch: boolean;
  /** Content scale of the chosen size (1 for Normal). Also on the island as the CSS variable `--scale`. */
  readonly scale: number;
}

/** What the folded island has to show, given to a style on every beat. */
export interface Folded {
  /** What the plugins in each glance spot say, or null when they have nothing. */
  readonly left: Glance | null;
  readonly right: Glance | null;
  /** The plugin speaking in each spot; a new speaker can pop in rather than morph. */
  readonly leftFrom?: string | undefined;
  readonly rightFrom?: string | undefined;
  /** The tint of whatever is in focus (album art…), or null for the accent. */
  readonly ambient: string | null;
  /** True while a glance asks for attention (a timer that ended…). */
  readonly alert: boolean;
  /** True while a glance widens the pill, like a live activity. */
  readonly wide: boolean;
  readonly now: number;
}

/** A style's look, once mounted. */
export interface StyleView {
  draw(folded: Folded): void;
  /** Stops whatever it started; its elements are removed for it. */
  destroy?(): void;
}

export interface StyleContext<Options = unknown> {
  /** The style's current option values; read them when needed, since the user can change them anytime. */
  options(): Options;
}

/**
 * How the folded island looks. A style only draws inside the folded pill: the island keeps hover,
 * opening, the panel, the hover area and the startup animation. It is drawn inside the island's
 * `.glance` element, which inherits the pill's colors (`--fg`, `--accent`, `--ambient`…) and
 * `--scale`.
 */
export interface PillStyle<F extends Fields = Fields> {
  /** 2–32 lowercase letters, digits or dashes; unique among styles, widgets and startup animations. */
  readonly id: string;
  /** Its name in Settings. */
  readonly label: string;
  /** One line under its name in Settings. */
  readonly description?: string;
  /** False when a live activity (music…) shouldn't widen it, e.g. for a style without text. */
  readonly widens?: boolean;
  /** User-configurable options, drawn under the style in Settings → Appearance. */
  readonly options?: F;
  /** Hidden until the cursor rests at the top center of the screen. */
  readonly hidden?: boolean;
  /**
   * Its folded size; the pill's when not given. Open, the island is never shorter than the pill,
   * so the panel sits the same under every style.
   */
  size?(pill: Pill, options: Values<F>): { width: number; height: number };
  /** Builds the look inside `root`, once each time the style is picked. */
  mount(root: HTMLElement, ctx: StyleContext<Values<F>>): StyleView;
}

export const defineStyle = <F extends Fields = Record<never, never>>(style: PillStyle<F>): PillStyle<F> => style;

/** Any style, when only its shape matters. */
export type AnyStyle = PillStyle<Fields>;
