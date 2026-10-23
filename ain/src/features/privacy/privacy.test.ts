// @vitest-environment happy-dom
/** The Mic & camera tab and glance: which apps use them, minus the ones the user ignores. */
import { describe, expect, it, vi } from "vitest";
import type { PrivacyPort, Usage } from "./service";

const { privacy, privacyGlance } = await import(".");

/** The tab on a fake backend whose usage a test can change. */
async function tab(first: Usage | null, ignore: string[] = []) {
  let push: (u: Usage | null) => void = () => {};
  const port: PrivacyPort = { watch: async (onChange) => ((push = onChange), onChange(first), () => {}) };
  const host = { refresh: vi.fn(), options: () => ({ ignore }), setOptions() {}, openSettings() {} };
  const widget = privacy.setup({ privacy: port }, host as never);
  const root = document.createElement("section");
  widget.panel?.(root);
  await Promise.resolve();
  const row = (kind: string) => root.querySelector<HTMLElement>(`.priv-row[data-kind=${kind}]`)!;
  return { host, widget, root, push, row, chips: (kind: string) => [...row(kind).querySelectorAll(".app-chip")].map((c) => c.textContent) };
}

describe("the Mic & camera tab", () => {
  it("lists the apps using each, folding the rest into a count", async () => {
    const t = await tab({ mic: ["Discord", "Zoom", "OBS", "Teams", "Slack"], camera: ["Zoom"] });
    expect(t.chips("mic")).toEqual(["Discord", "Zoom", "OBS", "+2"]);
    expect(t.row("mic").querySelector(".apps")?.getAttribute("title")).toBe("Discord\nZoom\nOBS\nTeams\nSlack");
    expect([t.chips("camera"), t.row("camera").dataset.active]).toEqual([["Zoom"], "true"]);
    expect(t.host.refresh).toHaveBeenCalled();
  });

  it("leaves out ignored apps, on the camera too", async () => {
    const t = await tab({ mic: ["Discord"], camera: ["NVIDIA Broadcast"] }, ["NVIDIA Broadcast"]);
    expect([t.row("camera").dataset.active, t.row("camera").textContent]).toEqual(["false", "CameraNot in use"]);
    expect(t.widget.glance?.(0)).toEqual({ text: "Discord", mark: "mic" });
  });

  it("says when the system can't tell", async () => {
    const t = await tab(null);
    expect([t.root.querySelector<HTMLElement>(".privacy")?.hidden, t.root.querySelector<HTMLElement>(".empty")?.hidden]).toEqual([true, false]);
    expect(t.row("mic").dataset.active).toBe("false");
    expect(t.widget.glance?.(0)).toBeNull();
  });

  it("redraws on a tick only while visible", async () => {
    const usage = { mic: ["Discord"], camera: [] as string[] };
    const t = await tab(usage);
    usage.mic = [];
    expect(t.widget.tick?.({ now: 0, visible: false })).toBeUndefined();
    expect(t.chips("mic")).toEqual(["Discord"]);
    t.widget.tick?.({ now: 0, visible: true });
    expect(t.row("mic").textContent).toBe("MicrophoneNot in use");
  });
});

describe("the privacy glance", () => {
  it("shortens a long app name", () => expect(privacyGlance({ mic: ["Microsoft Teams (work or school)"], camera: [] })?.text).toBe("Microsoft Tea…"));
});
