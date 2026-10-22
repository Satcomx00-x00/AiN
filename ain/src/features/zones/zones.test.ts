// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hint, mountOverlay } from "./overlay";
import { type Overlay, type ZonesPort, fromWire, idleZones } from "./service";

const { zones, drawPreview, TEMPLATES } = await import(".");

beforeEach(() => document.body.replaceChildren());
afterEach(() => vi.restoreAllMocks());

const ZONES = [
  { x: 10, y: 10, w: 300, h: 400 },
  { x: 320, y: 10, w: 300, h: 400 },
  { x: 630, y: 10, w: 300, h: 400 },
];

/** A port whose overlay the test pushes, recording what the overlay asks for. */
function port() {
  let push: (o: Overlay) => void = () => {};
  const asked: string[] = [];
  const p: ZonesPort = {
    ...idleZones,
    watchOverlay: async (onChange) => ((push = onChange), () => {}),
    snap: async (zone) => void asked.push(`snap ${zone}`),
    screen: async (by) => void asked.push(`screen ${by}`),
    cancel: async (refocus) => void asked.push(refocus ? "cancel" : "cancel, leaving the focus"),
  };
  return { port: p, asked, push: (o: Partial<Overlay>) => push({ zones: ZONES, lit: [], picking: false, screen: 0, screens: 1, ...o }) };
}

async function overlay() {
  const p = port();
  const root = document.createElement("div");
  document.body.append(root);
  const stop = mountOverlay(root, p.port);
  await Promise.resolve();
  const key = (code: string, key = code) => document.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true }));
  const boxes = () => [...root.querySelectorAll<HTMLElement>(".zo-zone")];
  return { ...p, root, stop, key, boxes };
}

describe("the zones overlay", () => {
  it("draws the zones it is sent where they go, lighting the ones under the pointer", async () => {
    const o = await overlay();
    o.push({ lit: [1] });
    expect(o.boxes().map((b) => [b.style.left, b.style.width, b.dataset.lit])).toEqual([
      ["10px", "300px", "false"],
      ["320px", "300px", "true"],
      ["630px", "300px", "false"],
    ]);
    const first = o.boxes()[0];
    o.push({ lit: [0, 1] });
    expect(o.boxes()[0]).toBe(first);
    expect(o.boxes().map((b) => b.dataset.lit)).toEqual(["true", "true", "false"]);
    expect(o.root.querySelector<HTMLElement>(".zo-hint")?.hidden).toBe(true);
  });

  it("ignores keys and clicks during a drag", async () => {
    const o = await overlay();
    o.push({});
    o.key("Digit1");
    o.boxes()[1]?.click();
    window.dispatchEvent(new Event("blur"));
    expect(o.asked).toEqual([]);
  });

  it("as the picker, snaps to the zone typed or clicked", async () => {
    const o = await overlay();
    o.push({ picking: true });
    expect(o.root.dataset.picking).toBe("true");
    o.key("Digit2");
    o.key("Numpad3");
    o.key("Digit9");
    o.boxes()[0]?.click();
    expect(o.asked).toEqual(["snap 1", "snap 2", "snap 0"]);
  });

  it("as the picker, moves between screens and cancels on Esc, a click beside the zones or leaving", async () => {
    const o = await overlay();
    o.push({ picking: true, screens: 2 });
    o.key("ArrowRight");
    o.key("ArrowLeft");
    o.key("Escape");
    o.root.click();
    window.dispatchEvent(new Event("blur"));
    expect(o.asked).toEqual(["screen 1", "screen -1", "cancel", "cancel", "cancel, leaving the focus"]);
    o.stop();
    o.key("Escape");
    expect(o.asked).toHaveLength(5);
  });

  it("says how to pick, with the screens when there are several", () => {
    const base = { zones: ZONES, lit: [], picking: true, screen: 1, screens: 3 };
    expect(hint(base)).toBe("Press 1–3 or click a zone · ← → screen 2 of 3 · Esc to cancel");
    expect(hint({ ...base, zones: ZONES.slice(0, 1), screens: 1 })).toBe("Press 1 or click the zone · Esc to cancel");
  });

  it("reads the backend's floats, which JSON may have turned to null", () => {
    expect(fromWire({ zones: [{ x: 1, y: null, w: 2, h: 3 }], lit: [], picking: false, screen: 0, screens: 1 }).zones).toEqual([{ x: 1, y: 0, w: 2, h: 3 }]);
  });
});

describe("the layout preview", () => {
  it("places each zone by its fraction of the screen, numbered, with a scaled gap", () => {
    const preview = document.createElement("div");
    drawPreview(preview, [{ x: 0, y: 0, w: 0.25, h: 1 }, { x: 0.25, y: 0, w: 0.75, h: 0.5 }], 16);
    const cells = [...preview.querySelectorAll<HTMLElement>(".zn-cell")];
    expect(cells.map((c) => [c.style.left, c.style.width, c.style.height, c.textContent])).toEqual([
      ["0%", "25%", "100%", "1"],
      ["25%", "75%", "50%", "2"],
    ]);
    expect(preview.style.getPropertyValue("--half")).toBe("1.28px");
  });

  it("follows the options as Settings changes them, and says what the system allows", async () => {
    let options = { template: "columns", count: 2, spacing: 8, drag: "shift", rotate: true, across: true };
    const asked: string[] = [];
    const p: ZonesPort = {
      ...idleZones,
      layout: async (template, count) => (asked.push(`${template} ${count}`), idleZones.layout(template, count, false)),
      support: async () => ({ moves: true, drags: true, note: "Allow AiN under Accessibility.", install: false }),
    };
    const root = document.createElement("div");
    document.body.append(root);
    const stop = zones.settingsPanel!(root, { zones: p }, { options: () => options, setOptions: () => {}, openPage: () => {} }) as () => void;
    await vi.waitFor(() => expect(root.querySelectorAll(".zn-cell")).toHaveLength(2));
    expect(root.querySelector(".zn-note")?.textContent).toBe("Allow AiN under Accessibility.");
    options = { ...options, count: 4 };
    document.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(root.querySelectorAll(".zn-cell")).toHaveLength(4));
    expect(root.querySelector<HTMLButtonElement>(".zn-install")?.hidden).toBe(true);
    stop();
    options = { ...options, count: 5 };
    document.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual(["columns 2", "columns 4"]);
  });
});

describe("the GNOME helper", () => {
  it("is offered where the desktop needs it, and says what's left to do once installed", async () => {
    let installed = 0;
    const p: ZonesPort = {
      ...idleZones,
      support: async () => ({ moves: false, drags: false, note: "GNOME lets no app move other apps' windows.", install: true }),
      installHelper: async () => void installed++,
    };
    const root = document.createElement("div");
    document.body.append(root);
    zones.settingsPanel!(root, { zones: p }, { options: () => ({ template: "columns", count: 2, spacing: 8 }) as never, setOptions: () => {}, openPage: () => {} });
    const install = await vi.waitFor(() => {
      const b = root.querySelector<HTMLButtonElement>(".zn-install");
      expect(b?.hidden).toBe(false);
      return b!;
    });
    install.click();
    await vi.waitFor(() => expect(install.hidden).toBe(true));
    expect(installed).toBe(1);
    expect(root.querySelector(".zn-note")?.textContent).toBe("Installed. Log out and back in once: GNOME starts it at login.");
  });
});

describe("the plugin", () => {
  it("is a tool on shortcuts the backend acts on, with no tab or glance", () => {
    expect(zones.slots).toEqual([]);
    expect(zones.commands?.map((c) => [c.id, c.surface])).toEqual([
      ["pick", "action"],
      ["next", "action"],
      ["previous", "action"],
    ]);
  });

  it("defaults to what the backend reads when nothing is saved", () => {
    const o = zones.options!;
    expect([o.template.default, o.count.default, o.spacing.default, o.drag.default, o.rotate.default, o.across.default]).toEqual([
      "priorityGrid",
      3,
      16,
      "shift",
      true,
      true,
    ]);
    expect(TEMPLATES.map(([id]) => id)).toEqual(["priorityGrid", "columns", "rows", "grid", "focus"]);
  });
});
