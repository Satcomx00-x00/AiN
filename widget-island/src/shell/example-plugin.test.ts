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

describe("the example startup animation", async () => {
  const { checkGreeting } = await import("./extensions");
  const { extensionRules } = await import("../features");
  const { default: wave } = await import("../../examples/plugins/wave.js");

  it("passes the checks, grows the pill and cleans up after itself", async () => {
    const checked = checkGreeting(wave(sdk) as never, extensionRules.taken);
    if (typeof checked === "string") throw new Error(checked);
    const animate = vi.spyOn(Element.prototype, "animate").mockImplementation(() => ({ finished: Promise.resolve() }) as unknown as Animation);
    const pill = document.createElement("div");
    pill.innerHTML = `<div class="surface"><div class="glance"></div></div>`;
    const surface = pill.querySelector<HTMLElement>(".surface")!;
    await checked.play({ island: pill, surface, glance: pill.querySelector(".glance"), size: { width: 200, height: 32 }, scale: 1 });
    const own = animate.mock.contexts.indexOf(pill);
    expect(animate.mock.calls[own]?.[0]).toEqual([expect.objectContaining({ width: "32px" }), expect.anything(), expect.objectContaining({ width: "200px" })]);
    expect(surface.children).toHaveLength(1);
    animate.mockRestore();
  });
});
