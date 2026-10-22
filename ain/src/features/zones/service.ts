import { follow, num } from "../../sdk/follow";
import { type OverlayChanged, type Support, type Template, commands, events } from "./bindings";

export type { Support, Template };

/** A rectangle: a fraction of a screen in a layout, or CSS pixels in the overlay. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What the overlay shows: a screen's zones, those lit up, and whether it's the picker. */
export interface Overlay {
  readonly zones: readonly Box[];
  readonly lit: readonly number[];
  readonly picking: boolean;
  /** Which screen of how many the picker shows. */
  readonly screen: number;
  readonly screens: number;
}

export interface ZonesPort {
  /** What zones can do on this system. */
  support(): Promise<Support>;
  /** A layout's zones, as fractions of a screen. */
  layout(template: Template, count: number, portrait: boolean): Promise<Box[]>;
  /** Calls `onChange` with what the overlay shows, now and on every change. */
  watchOverlay(onChange: (overlay: Overlay) => void): Promise<() => void>;
  /** The picker's choice: the zone at `zone`, from 0. */
  snap(zone: number): Promise<void>;
  /** Shows the picker on another screen, `by` on (negative: back). */
  screen(by: number): Promise<void>;
  /** Closes the picker, moving nothing; `refocus` gives the focus back to the window it was for. */
  cancel(refocus: boolean): Promise<void>;
  /** Installs what the desktop needs for zones to move windows (GNOME's helper extension). */
  installHelper(): Promise<void>;
}

const box = (b: { x: number | null; y: number | null; w: number | null; h: number | null }): Box => ({ x: num(b.x), y: num(b.y), w: num(b.w), h: num(b.h) });

export const fromWire = (o: OverlayChanged): Overlay => ({ ...o, zones: o.zones.map(box) });

export const tauriZones: ZonesPort = {
  support: () => commands.support(),
  layout: async (template, count, portrait) => (await commands.layout(template, count, portrait)).map(box),
  watchOverlay: (onChange) => follow(events.overlayChanged, commands.overlayState, (o) => onChange(fromWire(o))),
  snap: async (zone) => void (await commands.snap(zone)),
  screen: async (by) => void (await commands.screen(by)),
  cancel: async (refocus) => void (await commands.cancel(refocus)),
  installHelper: async () => void (await commands.installHelper()),
};

/** Even columns, nothing to move: for the browser previews. */
export const idleZones: ZonesPort = {
  support: async () => ({ moves: false, drags: false, note: "Zones move windows in the app, not in this preview.", install: false }),
  layout: async (_, count) => Array.from({ length: Math.max(1, count) }, (_, i) => ({ x: i / Math.max(1, count), y: 0, w: 1 / Math.max(1, count), h: 1 })),
  watchOverlay: async (onChange) => (onChange({ zones: [], lit: [], picking: false, screen: 0, screens: 1 }), () => {}),
  snap: async () => {},
  screen: async () => {},
  cancel: async () => {},
  installHelper: async () => {},
};
