// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { invoke } = await import("@tauri-apps/api/core");
const { POWER, armedButton } = await import("./quit");
const { tauriSettings } = await import("./settings");

const labels = { label: "Quit Island", armed: "Click again to quit Island" };

afterEach(() => vi.useRealTimers());

describe("the quit button", () => {
  it("doesn't quit on a single click, only says what a second one does", () => {
    const quit = vi.fn();
    const el = armedButton(POWER, quit, labels);
    expect(el.getAttribute("aria-label")).toBe("Quit Island");
    el.click();
    expect(quit).not.toHaveBeenCalled();
    expect(el.dataset.armed).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("Click again to quit Island");
  });

  it("quits on a second click, once", () => {
    const quit = vi.fn();
    const el = armedButton(POWER, quit, labels);
    el.click();
    el.click();
    expect(quit).toHaveBeenCalledOnce();
    expect(el.dataset.armed).toBe("false");
  });

  it("disarms after a moment, so a much later click starts over", () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const el = armedButton(POWER, quit, labels, "", 3000);
    el.click();
    vi.advanceTimersByTime(3000);
    expect(el.dataset.armed).toBe("false");
    el.click();
    expect(quit).not.toHaveBeenCalled();
  });
});

describe("quitting", () => {
  it("asks the backend to end the app", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await tauriSettings.quit();
    expect(invoke).toHaveBeenLastCalledWith("plugin:settings|quit");
  });
});
