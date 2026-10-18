import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { noCommunity, offerState, tauriCommunity } = await import("./community");

const offer = { id: "orbit-clock", name: "Orbit clock", description: "", repo: "https://github.com/o/r", file: "orbit-clock/index.js", problem: null, options: null };

describe("the community store", () => {
  it("offers to install a plugin, to update one already in the folder, or neither when it can't be installed", () => {
    expect(offerState(offer, ["other.js"])).toBe("install");
    expect(offerState(offer, ["orbit-clock/index.js"])).toBe("update");
    expect(offerState({ ...offer, problem: "only GitHub repositories can be installed from the app", options: null }, ["orbit-clock/index.js"])).toBe("unavailable");
  });

  it("asks the app's backend by id, never with a URL", async () => {
    invoke.mockResolvedValueOnce({ url: "u", plugins: [offer] }).mockResolvedValueOnce("orbit-clock/index.js").mockResolvedValueOnce(null);
    expect(await tauriCommunity.catalog()).toEqual({ url: "u", plugins: [offer] });
    expect(await tauriCommunity.install("orbit-clock")).toBe("orbit-clock/index.js");
    expect(await tauriCommunity.openRepo("orbit-clock")).toBeUndefined();
    expect(invoke.mock.calls).toEqual([
      ["plugin:store|catalog"],
      ["plugin:store|install", { id: "orbit-clock" }],
      ["plugin:store|open_repo", { id: "orbit-clock" }],
    ]);
  });

  it("isn't there outside the app", async () => {
    await expect(noCommunity.catalog()).rejects.toThrow("only available in the app");
    await expect(noCommunity.install("orbit-clock")).rejects.toThrow("only available in the app");
  });
});
