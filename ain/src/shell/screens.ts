import { follow } from "../sdk/follow";
import type { SelectOption } from "../sdk/select";
import { type Screen, commands, events } from "./bindings/island";

export type { Screen };

/** The connected screens the pill can sit on. */
export interface ScreensPort {
  /** Calls `onChange` with the screens now and whenever one is plugged in, out or rearranged. */
  watch(onChange: (screens: readonly Screen[]) => void): Promise<() => void>;
}

export const tauriScreens: ScreensPort = {
  watch: (onChange) => follow(events.screensChanged, commands.screens, onChange),
};

/** A fixed list of screens, for the browser previews and tests; none by default. */
export const fixedScreens = (screens: readonly Screen[] = []): ScreensPort => ({
  watch: async (onChange) => {
    onChange(screens);
    return () => {};
  },
});

/** The select's value for "the primary screen", which saves as `null`. */
export const PRIMARY = "primary";

const resolution = (s: Screen): string => {
  const scale = s.scale !== null && s.scale !== 1 ? ` · ${Math.round(s.scale * 100)}%` : "";
  return `${s.width} × ${s.height}${scale}`;
};

/** The choices for the pill's screen: the primary (default), each connected screen, and the saved one while it's unplugged. */
export function screenOptions(screens: readonly Screen[], chosen: string | null): SelectOption[] {
  const primary = screens.find((s) => s.primary);
  const connected = screens.map<SelectOption>((s) => ({ value: s.id, label: s.id, detail: resolution(s), badge: s.primary ? "Primary" : undefined }));
  const away: SelectOption[] =
    chosen !== null && !screens.some((s) => s.id === chosen)
      ? [{ value: chosen, label: chosen, detail: "Not connected: the pill is on the primary screen until it's back", badge: "Unplugged" }]
      : [];
  return [{ value: PRIMARY, label: "Primary screen", detail: primary ? `Now ${primary.id}` : "The system's main screen" }, ...connected, ...away];
}

/** The setting's value for a select value. */
export const screenSetting = (value: string): string | null => (value === PRIMARY ? null : value);
