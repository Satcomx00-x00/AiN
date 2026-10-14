import type { Layout } from "./core/placement";

/**
 * The default placement, used until the user changes it in Settings.
 * A plugin not listed anywhere isn't loaded at all.
 */
export const layout: Layout = {
  glance: {
    left: ["clock"],
    // Priority order, first with something to show wins: a volume change pops up briefly,
    // mic/camera use stays visible, then a running timer, what's playing, and finally CPU load.
    right: ["volume", "privacy", "timer", "media", "stats"],
  },
  tabs: ["media", "clock", "timer", "volume", "clipboard", "stats", "privacy"],
};
