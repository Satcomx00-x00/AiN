export interface IntentDelays {
  /** Hover time before opening, so passing the cursor by doesn't pop the island. */
  readonly open: number;
  /** Grace time before closing, so brief exits don't collapse it. */
  readonly close: number;
}

export interface Intent {
  enter(): void;
  leave(): void;
  /** Applies a state right away, cancelling anything pending. */
  set(open: boolean): void;
}

/** Debounces open/close requests; only the latest request wins. Delays are read on each request. */
export function intent(apply: (open: boolean) => void, isOpen: () => boolean, delays: () => IntentDelays): Intent {
  let pending: ReturnType<typeof setTimeout> | undefined;
  const schedule = (open: boolean, delay: number) => {
    clearTimeout(pending);
    pending = setTimeout(() => apply(open), delay);
  };
  return {
    enter: () => schedule(true, isOpen() ? 0 : delays().open),
    leave: () => schedule(false, delays().close),
    set: (open) => {
      clearTimeout(pending);
      apply(open);
    },
  };
}
