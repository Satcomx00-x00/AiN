// @vitest-environment happy-dom
/** The island window's entry point: it starts the island in `#island`, and a right-click opens Settings. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const start = vi.fn<(root: HTMLElement) => Promise<unknown>>();
const open = vi.fn<(target?: string) => Promise<void>>();
vi.mock("./app", () => ({ start }));
vi.mock("../../settings", () => ({ tauriSettings: { open } }));

/** Loads a fresh copy of the window's script into a page holding `markup`. */
async function load(markup: string) {
  document.body.innerHTML = markup;
  vi.resetModules();
  await import("./main");
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  start.mockReset().mockResolvedValue({});
  open.mockReset().mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("the island window", () => {
  it("starts the island in its #island element", async () => {
    await load(`<div id="island" data-open="false"></div>`);
    expect(start).toHaveBeenCalledWith(document.querySelector("#island"));
  });

  it("starts nothing in a page without one", async () => {
    await load("");
    expect(start).not.toHaveBeenCalled();
  });

  it("logs an island that fails to start", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("no window");
    start.mockRejectedValue(failure);
    await load(`<div id="island"></div>`);
    await settle();
    expect(error).toHaveBeenCalledWith("[island] failed to start", failure);
  });

  it("opens Settings on a right-click instead of the browser's menu", async () => {
    await load(`<div id="island"></div>`);
    const click = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.querySelector("#island")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith();
  });

  it("logs when Settings can't be opened", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("gone");
    open.mockRejectedValue(failure);
    await load(`<div id="island"></div>`);
    document.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true }));
    await settle();
    expect(error).toHaveBeenCalledWith("[island] could not open settings", failure);
  });
});
