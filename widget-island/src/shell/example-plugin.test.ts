// @vitest-environment happy-dom
/** The example plugin the docs point to must keep working as the SDK changes. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { check, confine } = await import("./extensions");
const { sdk } = await import("../sdk");
const { default: factory } = await import("../../examples/plugins/cpu-alarm.js");

describe("the example plugin", () => {
  it("passes every check and works with the services it asks for", async () => {
    const checked = check(factory(sdk), { taken: new Set(), services: ["stats", "media", "volume", "privacy"] });
    if (typeof checked === "string") throw new Error(checked);
    expect(checked.needs).toEqual(["stats"]);

    let limit = 85;
    const log = vi.fn();
    const host = { refresh() {}, options: () => ({ limit }) as never, setOptions() {}, openSettings() {} };
    const stats = { stats: async () => ({ cpu: 90, memUsed: 0, memTotal: 1, rxPerSec: 0, txPerSec: 0, sampledAt: 0 }) };
    const widget = confine(checked.plugin, checked.needs, log).setup({ stats, clipboard: {} } as never, host);
    const root = document.createElement("section");
    widget.panel?.(root);

    expect(widget.glance?.(0)).toBeNull();
    await widget.tick?.({ now: 0, visible: true });
    expect(root.textContent).toBe("CPU90%");
    expect(widget.glance?.(0)).toEqual({ text: "CPU 90%", tone: "alert" });
    limit = 95;
    expect(widget.glance?.(0)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});
