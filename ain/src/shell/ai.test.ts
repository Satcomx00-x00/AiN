import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { noAi, tauriAi } = await import("./ai");

describe("the ai service", () => {
  it("asks the model picked for plugins, with or without instructions", async () => {
    invoke.mockResolvedValue("Bonjour");
    expect(await tauriAi.ask("Hello", { instructions: "In French." })).toBe("Bonjour");
    await tauriAi.ask("Hi");
    expect(invoke.mock.calls).toEqual([
      ["plugin:providers|ask", { instructions: "In French.", text: "Hello" }],
      ["plugin:providers|ask", { instructions: "", text: "Hi" }],
    ]);
  });

  it("says why it can't answer outside the app", async () => {
    await expect(noAi.ask("Hi")).rejects.toThrow("only available in the app");
  });
});
