import "./zones.css";
import { mountOverlay } from "../../../features/zones/overlay";
import { type ZonesPort, idleZones, tauriZones } from "../../../features/zones/service";
import { layout } from "../../../features/layout";
import { defaults, memorySettings, parseSettings, tauriSettings } from "../../settings";

const inTauri = "__TAURI_INTERNALS__" in window;

/** In the browser preview, `?pick` shows the picker over a sample priority grid; otherwise a drag over it. */
const sample: ZonesPort = {
  ...idleZones,
  watchOverlay: async (onChange) => {
    const [w, h, gap] = [innerWidth, innerHeight, 16];
    const third = (w - gap * 4) / 4;
    const zones = [
      { x: gap, y: gap, w: third, h: h - gap * 2 },
      { x: gap * 2 + third, y: gap, w: third * 2 + gap, h: h - gap * 2 },
      { x: gap * 4 + third * 3, y: gap, w: third, h: h - gap * 2 },
    ];
    const picking = new URLSearchParams(location.search).has("pick");
    onChange({ zones, lit: picking ? [] : [1], picking, screen: 0, screens: 2 });
    return () => {};
  },
};

const root = document.createElement("div");
root.className = "zo-root";
document.body.append(root);
mountOverlay(root, inTauri ? tauriZones : sample);

// The zones take the accent color chosen in Settings.
const fallback = defaults(layout);
void (inTauri ? tauriSettings : memorySettings()).watch((raw) => {
  document.documentElement.style.setProperty("--accent", parseSettings(raw, fallback).general.accentColor);
});
