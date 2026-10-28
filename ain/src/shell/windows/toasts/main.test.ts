// @vitest-environment happy-dom
/**
 * The corner toast window's entry point: it draws what the island sends, places itself with the
 * backend, tells the island what the user did, and says when it is ready.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATIONS, normalize } from "../../notifications";

const invoke = vi.fn(async () => null);
const emit = vi.fn(async () => {});
const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit, listen: vi.fn(async (name: string, handler: never) => (handlers.set(name, handler), () => {})) }));

describe("the corner toast window", () => {
  it("draws the toasts it is sent, placed in their corner, and says what the user did", async () => {
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (f(0), 0));
    await import("./main");
    expect(emit).toHaveBeenCalledWith("toasts:ready");
    const n = normalize("n1", { id: "mail", label: "Mail", icon: "<path/>" }, { title: "Hi" }, Date.now());
    handlers.get("toasts:sync")!({ payload: { notices: [n], settings: { ...DEFAULT_NOTIFICATIONS, corner: "bottom-right" }, colors: { bg: "#000", fg: "#fff", accent: "#0a84ff" } } });
    expect(document.querySelector(".toasts .notice-title")?.textContent).toBe("Hi");
    expect(invoke).toHaveBeenCalledWith("plugin:toasts|place", { corner: "bottom-right", width: expect.any(Number), height: expect.any(Number) });
    document.querySelector<HTMLButtonElement>(".notice-close")!.click();
    expect(emit).toHaveBeenLastCalledWith("toasts:event", { kind: "close", id: "n1" });
    vi.unstubAllGlobals();
  });
});
