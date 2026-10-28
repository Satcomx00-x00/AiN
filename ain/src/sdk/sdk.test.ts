import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { sdk } = await import(".");
const { follow, num } = await import("./follow");

describe("the SDK handed to plugins", () => {
  it("can't be changed by a plugin, at any level", () => {
    expect(Object.isFrozen(sdk)).toBe(true);
    for (const part of [sdk.options, sdk.dom, sdk.chart, sdk.color, sdk.ui]) expect(Object.isFrozen(part)).toBe(true);
  });

  it("defines plugins as given", () => {
    const def = { id: "x", label: "X", description: "", icon: "", slots: ["tab"] as const, setup: () => ({}) };
    expect(sdk.definePlugin(def)).toBe(def);
  });

  it("defines notifiers as given", () => {
    const def = { id: "ticker", label: "Ticker", show: () => {} };
    expect(sdk.defineNotifier(def)).toBe(def);
  });

  it("defines pill styles as given", () => {
    const def = { id: "neon", label: "Neon", mount: () => ({ draw() {} }) };
    expect(sdk.defineStyle(def)).toBe(def);
  });

  it("offers the glance spot the built-in Pill draws, for styles", async () => {
    const { glanceSlot } = await import("./glance");
    expect(sdk.ui.glanceSlot).toBe(glanceSlot);
    expect(Object.keys(sdk.ui).sort()).toEqual(["glanceSlot", "select"]);
  });

  it("offers the same option builders as the built-in features use", async () => {
    const options = await import("./options");
    expect(sdk.options.toggle).toBe(options.toggle);
    expect(Object.keys(sdk.options).sort()).toEqual(["choice", "color", "folder", "list", "number", "secret", "text", "toggle"]);
  });
});

describe("follow", () => {
  it("listens before the first read, so a change in between isn't lost", async () => {
    const order: string[] = [];
    const seen: number[] = [];
    let push: (n: number) => void = () => {};
    const event = {
      listen: async (handler: (e: { payload: number }) => void) => {
        order.push("listen");
        push = (n) => handler({ payload: n });
        return () => void order.push("stop");
      },
    };
    const read = async () => {
      order.push("read");
      push(2); // arrives while reading
      return 1;
    };
    const stop = await follow(event, read, (n) => seen.push(n));
    expect(order).toEqual(["listen", "read"]);
    expect(seen).toEqual([2, 1]);
    stop();
    expect(order).toEqual(["listen", "read", "stop"]);
  });

  it("stops listening when the first read fails", async () => {
    const stop = vi.fn();
    const event = { listen: async () => stop };
    await expect(follow(event, () => Promise.reject(new Error("x")), () => {})).rejects.toThrow("x");
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("num", () => {
  it.each([
    [0.5, 0.5],
    [null, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])("%s → %s", (n, out) => expect(num(n)).toBe(out));

  it("uses the given fallback", () => expect(num(null, 1)).toBe(1));
});
