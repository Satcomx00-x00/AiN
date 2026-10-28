/** True on Windows. */
export const isWindows = (agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean => /Windows/.test(agent);

const KEY_LABELS: Record<string, string> = {
  Super: "Win",
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Backquote: "`",
  Space: "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

/** "Super+Shift+KeyB" → ["Win", "Shift", "B"], for display as keycaps. */
export const keycaps = (shortcut: string): string[] => shortcut.split("+").map((part) => KEY_LABELS[part] ?? part.replace(/^Key|^Digit/, ""));
