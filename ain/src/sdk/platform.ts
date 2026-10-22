/** True on macOS, where Cmd does what Ctrl does elsewhere (copy, paste, save) and the Super key is Cmd. */
export const isMac = (agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean => /Mac/.test(agent);

/** True on Windows. */
export const isWindows = (agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean => /Windows/.test(agent);

/** The modifier for copy, paste and save, as people call it on this system: "Cmd" or "Ctrl". */
export const primaryKey = (mac = isMac()): string => (mac ? "Cmd" : "Ctrl");

const KEY_LABELS: Record<string, string> = { Super: "Win", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Backquote: "`", Space: "Space" };
/** Where macOS names the keys differently. */
const MAC_LABELS: Record<string, string> = { Super: "Cmd", Ctrl: "Control", Alt: "Option" };

/** "Super+Shift+KeyB" → ["Win", "Shift", "B"] (["Cmd", "Shift", "B"] on macOS), for display as keycaps. */
export const keycaps = (shortcut: string, mac = isMac()): string[] =>
  shortcut.split("+").map((part) => (mac ? MAC_LABELS[part] : undefined) ?? KEY_LABELS[part] ?? part.replace(/^Key|^Digit|^Arrow/, ""));
