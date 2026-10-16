/** True on macOS, where Cmd does what Ctrl does elsewhere (copy, paste, save) and the Super key is Cmd. */
export const isMac = (agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean => /Mac/.test(agent);

/** The modifier for copy, paste and save, as people call it on this system: "Cmd" or "Ctrl". */
export const primaryKey = (mac = isMac()): string => (mac ? "Cmd" : "Ctrl");
