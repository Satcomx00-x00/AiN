import type { Notification } from "../../sdk/notify";
import type { Center } from "../../shell/notifications";

export type { Notification };

/** The notification history, for the Notifications tab and plugins that list `notifications` in `needs`. */
export interface NotificationsPort {
  /** Newest first. */
  list(): readonly Notification[];
  /** Calls `onChange` with the history now and on every change; returns how to stop. */
  watch(onChange: (history: readonly Notification[]) => void): Promise<() => void>;
  /** The user has seen them all: the dot on the pill goes. */
  markSeen(): void;
  /** Takes one out of the history. */
  remove(id: string): void;
  clear(): void;
  /** Presses one of its actions. */
  act(id: string, actionId: string): void;
}

export const centerPort = (c: Center): NotificationsPort => ({
  list: () => c.list(),
  watch: async (onChange) => c.watch(onChange),
  markSeen: () => c.markSeen(),
  remove: (id) => c.remove(id),
  clear: () => c.clear(),
  act: (id, actionId) => c.act(id, actionId),
});
