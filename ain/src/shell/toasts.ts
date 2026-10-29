/**
 * The island's side of the corner toast window: it sends the window what to show and hears what
 * the user did. The window may load after the first toast, so it says when it's ready and gets
 * the latest state again.
 */
import { emitTo, listen } from "@tauri-apps/api/event";
import { commands } from "./bindings/toasts";
import type { ToastEvent, ToastPort, ToastSync } from "./notice-view";

export const TOASTS_WINDOW = "toasts";
export const TOAST_EVENTS = { sync: "toasts:sync", event: "toasts:event", ready: "toasts:ready" } as const;

export function tauriToasts(): ToastPort {
  let last: ToastSync | null = null;
  let made: Promise<void> | null = null;
  const send = async (state: ToastSync) => {
    // Made on the first toast: no window until one is needed.
    if (state.notices.length) made ??= commands.ensure().then(() => undefined);
    if (made) await emitTo(TOASTS_WINDOW, TOAST_EVENTS.sync, state);
  };
  return {
    async sync(state) {
      last = state;
      await send(state);
    },
    async listen(onEvent) {
      const stops = await Promise.all([
        listen<ToastEvent>(TOAST_EVENTS.event, (e) => onEvent(e.payload)),
        listen(TOAST_EVENTS.ready, () => void (last && send(last))),
      ]);
      return () => stops.forEach((stop) => stop());
    },
  };
}
