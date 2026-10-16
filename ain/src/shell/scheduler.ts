/** Wraps an async task so runs never overlap; calls made mid-run collapse into one follow-up run. */
export function coalesce(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await task();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/** Delay until just after the next wall-clock second, so clocks flip on time. */
export const msToNextSecond = (now: number) => 1000 - (now % 1000) + 8;

export interface Ticker {
  start(): void;
  /** Runs the task as soon as possible, outside the regular beat. */
  now(): void;
  stop(): void;
}

/** Runs `task` once per wall-clock second after `start()`, without overlapping runs. */
export function ticker(task: () => Promise<void>): Ticker {
  const run = coalesce(task);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const beat = () => {
    if (stopped) return;
    void run();
    timer = setTimeout(beat, msToNextSecond(Date.now()));
  };
  return {
    start: () => {
      stopped = false;
      clearTimeout(timer);
      beat();
    },
    now: () => void run(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
