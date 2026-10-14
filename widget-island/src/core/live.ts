import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { z } from "zod";

/**
 * Follows a value a backend plugin watches: calls `onChange` with the current value, then again
 * each time the plugin emits `event`. Returns a function that stops listening.
 */
export async function follow<T>(event: string, command: string, schema: z.ZodType<T>, onChange: (value: T) => void): Promise<() => void> {
  // Listen first so a change between the two calls isn't missed.
  const stop = await listen<unknown>(event, (e) => onChange(schema.parse(e.payload)));
  onChange(schema.parse(await invoke(command)));
  return stop;
}
