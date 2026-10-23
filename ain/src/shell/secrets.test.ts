import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { memorySecrets, secretReader } = await import("./secrets");

describe("secretReader", () => {
  it("reads a secret once, until it changes", async () => {
    const port = memorySecrets();
    await port.set("weather", "apiKey", "first");
    const get = vi.spyOn(port, "get");
    const read = secretReader(port);
    await Promise.resolve();
    expect(await read("weather", "apiKey")).toBe("first");
    expect(await read("weather", "apiKey")).toBe("first");
    expect(get).toHaveBeenCalledTimes(1);

    await port.set("weather", "apiKey", "second");
    expect(await read("weather", "apiKey")).toBe("second");
    await port.set("weather", "apiKey", "");
    expect(await read("weather", "apiKey")).toBe("");
  });

  it("logs a failed read, gives an empty secret, and tries again next time", async () => {
    const port = memorySecrets();
    const log = vi.fn();
    vi.spyOn(port, "get").mockRejectedValueOnce(new Error("locked")).mockResolvedValueOnce("ok");
    const read = secretReader(port, log);
    expect(await read("weather", "apiKey")).toBe("");
    expect(log).toHaveBeenCalledWith(`[island] plugin "weather" can't read its secret "apiKey": Error: locked`);
    expect(await read("weather", "apiKey")).toBe("ok");
  });

  it("logs when it can't follow changes, and still reads", async () => {
    const port = memorySecrets();
    await port.set("weather", "apiKey", "k");
    vi.spyOn(port, "onChange").mockRejectedValueOnce(new Error("no events"));
    const log = vi.fn();
    const read = secretReader(port, log);
    expect(await read("weather", "apiKey")).toBe("k");
    expect(log).toHaveBeenCalledExactlyOnceWith("[island] can't follow secret changes: Error: no events");
  });
});

describe("memorySecrets", () => {
  it("keeps secrets trimmed, says which are saved, and stops telling a listener that stopped", async () => {
    const port = memorySecrets();
    const changes: string[] = [];
    const stop = await port.onChange((plugin, key) => changes.push(`${plugin}/${key}`));
    await port.set("weather", "apiKey", "  k3y ");
    expect([await port.get("weather", "apiKey"), await port.get("weather", "token")]).toEqual(["k3y", null]);
    expect(await port.saved("weather", ["token", "apiKey"])).toEqual([false, true]);
    stop();
    await port.set("weather", "apiKey", " ");
    expect(await port.saved("weather", ["apiKey"])).toEqual([false]);
    expect(changes).toEqual(["weather/apiKey"]);
  });
});
