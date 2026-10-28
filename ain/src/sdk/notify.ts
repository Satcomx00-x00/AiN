/**
 * Notifications: what plugins post with `host.notify`, what the island shows (in the pill, as a
 * bubble under it or as a toast in a corner) and keeps in its history, and the formats plugins can
 * add with `defineNotifier`. The user's settings (do not disturb, duration, each source on or off)
 * always apply.
 */

export type Urgency = "low" | "normal" | "urgent";

/** A button on a notification; pressing it calls the poster's `onNotificationAction`. */
export interface NoticeAction {
  readonly id: string;
  readonly label: string;
}

/** What a plugin posts. */
export interface Notice {
  readonly title: string;
  readonly body?: string;
  /** Inner SVG markup for a 16×16 stroke icon; the poster's icon when not given. */
  readonly icon?: string;
  /** At most three; more are dropped. */
  readonly actions?: readonly NoticeAction[];
  /** "urgent" shows even in do not disturb when the user allows it; "low" only goes to history. */
  readonly urgency?: Urgency;
  /** A notification with the same tag from the same source replaces the earlier one. */
  readonly tag?: string;
  /** What it is about, in freedesktop's words: "email.arrived", "transfer.complete", "device.added"… */
  readonly category?: string;
  /** Shown, never kept: it leaves no trace in the history (nor shows in do not disturb). */
  readonly transient?: boolean;
}

/**
 * A notification as the freedesktop Desktop Notifications Specification has it (the arguments of
 * `org.freedesktop.Notifications.Notify`, as GNOME and KDE take them).
 */
export interface FreedesktopNotice {
  readonly app_name?: string;
  /** Non-zero: replaces the earlier notification posted with the same id. */
  readonly replaces_id?: number;
  /** Inner SVG markup here; theme icon names aren't drawn. */
  readonly app_icon?: string;
  readonly summary: string;
  readonly body?: string;
  /** Pairs of action id and label: ["open", "Open", "later", "Later"]. */
  readonly actions?: readonly string[];
  readonly hints?: {
    /** 0 low, 1 normal, 2 critical. */
    readonly urgency?: 0 | 1 | 2;
    readonly category?: string;
    readonly transient?: boolean;
  };
  /** Ignored: the user decides how long notifications show. */
  readonly expire_timeout?: number;
}

/** A notification as the W3C Notifications API has it: `new Notification(title, options)`. */
export interface WebNotice {
  readonly title: string;
  readonly options: {
    readonly body?: string;
    /** Inner SVG markup here; image URLs aren't drawn. */
    readonly icon?: string;
    readonly tag?: string;
    readonly actions?: readonly { readonly action: string; readonly title: string }[];
    /** Kept in the history without showing. */
    readonly silent?: boolean;
    /** Ignored: the user decides how long notifications show. */
    readonly requireInteraction?: boolean;
  };
}

/** A Windows toast: its XML (the ToastGeneric template), and the tag and group that replace one. */
export interface WindowsNotice {
  readonly toastXml: string;
  readonly tag?: string;
  readonly group?: string;
}

/** What `host.notify` takes: AiN's own notice, or one in a standard format. */
export type AnyNotice = Notice | FreedesktopNotice | WebNotice | WindowsNotice;

/** Who a notification comes from: a plugin, or an app on this computer. */
export interface NoticeSource {
  readonly id: string;
  readonly label: string;
  /** Inner SVG markup for a 16×16 stroke icon. */
  readonly icon: string;
}

/** A notification as the island keeps it. */
export interface Notification {
  readonly id: string;
  readonly source: NoticeSource;
  readonly title: string;
  readonly body: string;
  readonly icon: string;
  readonly actions: readonly NoticeAction[];
  readonly urgency: Urgency;
  readonly tag: string | null;
  readonly category: string | null;
  readonly transient: boolean;
  /** When it was posted (or last updated), in ms since the epoch. */
  readonly at: number;
  /** False until the user has seen the history or the notification itself. */
  readonly seen: boolean;
}

/** What `host.notify` returns: the posted notification, to change or take back. */
export interface NotificationHandle {
  readonly id: string;
  update(patch: Partial<Notice>): void;
  dismiss(): void;
}

/**
 * What a `notifications` hook returns for each notification about to show: it as is or changed
 * (the id and source are kept), "silent" to keep it in the history without showing it, or null to
 * drop it.
 */
export type HookResult = Notification | "silent" | null;

/** What a notifier can do with the notification it shows. */
export interface NotifierContext {
  /** Closes it: the notifier's cleanup runs. */
  dismiss(): void;
  /** Presses one of its actions. */
  act(actionId: string): void;
}

/**
 * Another way to show notifications, picked under Settings → Notifications → Show as. It draws
 * each one into `stage`, a box under the pill (where the bubble goes), and returns a function
 * that removes what it added. The island times it out per the user's duration.
 */
export interface Notifier {
  /** 2–32 lowercase letters, digits or dashes; unique among notifiers, widgets, styles and animations. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  show(stage: HTMLElement, notification: Notification, ctx: NotifierContext): (() => void) | void;
}

export const defineNotifier = (notifier: Notifier): Notifier => notifier;

/** Most actions a notification keeps. */
export const MAX_ACTIONS = 3;
