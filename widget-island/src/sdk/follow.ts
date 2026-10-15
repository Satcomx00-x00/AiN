/** A typed event from generated bindings: something that can be listened to. */
export interface Followable<T> {
  listen(handler: (event: { payload: T }) => void): Promise<() => void>;
}

/**
 * Follows a value a backend feature watches: calls `onChange` with the current value (from `read`),
 * then again each time the feature emits `event`. Returns a function that stops listening.
 */
export async function follow<T>(event: Followable<T>, read: () => Promise<T>, onChange: (value: T) => void): Promise<() => void> {
  // Listen first so a change between the two calls isn't missed.
  const stop = await event.listen((e) => onChange(e.payload));
  try {
    onChange(await read());
  } catch (e) {
    stop();
    throw e;
  }
  return stop;
}

/** Floats arrive as `number | null`: JSON writes NaN and infinities as null. Those mean nothing here. */
export const num = (n: number | null, fallback = 0): number => (n === null || !Number.isFinite(n) ? fallback : n);
