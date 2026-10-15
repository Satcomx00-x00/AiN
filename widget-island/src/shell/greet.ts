import { GREETING_LIMIT_MS, type Greeting, type Stage } from "../sdk/greeting";

/** The setting's value for no startup animation. */
export const NO_GREETING = "none";

/**
 * Plays the chosen greeting on `island`: nothing for "none" or when motion should be reduced, the
 * first greeting when the chosen one is gone (e.g. its plugin was removed). A greeting that throws
 * or runs too long can't hold the island up: it resolves anyway, reporting why.
 */
export async function greet(
  island: HTMLElement,
  size: Stage["size"],
  greetings: readonly Greeting[],
  chosen: string,
  motion: boolean,
  log: (message: string) => void = console.warn,
  limit = GREETING_LIMIT_MS,
): Promise<void> {
  if (!motion || chosen === NO_GREETING) return;
  const greeting = greetings.find((g) => g.id === chosen) ?? greetings[0];
  const surface = island.querySelector<HTMLElement>(".surface");
  if (!greeting || !surface) return;
  const stage: Stage = { island, surface, glance: island.querySelector<HTMLElement>(".glance"), size };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), limit)));
  try {
    const outcome = await Promise.race([Promise.resolve(greeting.play(stage)).then(() => "done" as const), late]);
    if (outcome === "late") log(`[island] greeting "${greeting.id}" ran past ${limit} ms; going on without it`);
  } catch (e) {
    log(`[island] greeting "${greeting.id}" failed: ${String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}
