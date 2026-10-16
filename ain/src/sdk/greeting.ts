/** What a startup animation can work with: the pill, as it is about to appear. */
export interface Stage {
  /** The pill itself (#island): animate its width, transform, opacity… */
  readonly island: HTMLElement;
  /** Its inside, clipped to its shape: add elements here, and remove them when done. */
  readonly surface: HTMLElement;
  /** The usual glances (time, music…): hide them until the animation is done. */
  readonly glance: HTMLElement | null;
  /** The pill's resting size, in px: the chosen style's, at the chosen size. */
  readonly size: { readonly width: number; readonly height: number };
  /** Content scale of the chosen pill size (1 for Normal); scale drawn details by it. Also `--scale` in CSS. */
  readonly scale: number;
}

/**
 * An animation the pill plays when the island starts (and when it is picked in Settings, to
 * preview it). `play` resolves once it is done; it should clean up what it added. It is given a few
 * seconds at most: past that, the island goes on without it.
 */
export interface Greeting {
  /** 2–32 lowercase letters, digits or dashes; unique among greetings and widgets. */
  readonly id: string;
  /** Its name in Settings. */
  readonly label: string;
  play(stage: Stage): Promise<void> | void;
}

export const defineGreeting = (greeting: Greeting): Greeting => greeting;

/** How long a greeting may run before the island carries on without it. */
export const GREETING_LIMIT_MS = 6000;

/** Runs `animations` (Web Animations) and waits for them all; a cancelled one counts as done. */
export async function settle(animations: readonly Animation[]): Promise<void> {
  await Promise.all(animations.map((a) => a.finished.catch(() => undefined)));
}
