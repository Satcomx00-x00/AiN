// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATIONS, normalize } from "../../notifications";
import type { ToastSync } from "../../notice-view";
import { GUTTER, TOAST_WIDTH, toastStack } from "./stack";

const SOURCE = { id: "mail", label: "Mail", icon: "<path/>" };
const COLORS = { bg: "#000000", fg: "#f5f5f7", accent: "#0a84ff" };
const note = (id: string, title = id) => normalize(id, SOURCE, { title, actions: [{ id: "open", label: "Open" }] }, Date.now());
const state = (ids: string[], patch: Partial<ToastSync["settings"]> = {}): ToastSync => ({
  notices: ids.map((id) => note(id)),
  settings: { ...DEFAULT_NOTIFICATIONS, format: "toast", animation: "none", ...patch },
  colors: COLORS,
});

function setup() {
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (f(0), 0));
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const port = { place: vi.fn(async () => {}), send: vi.fn() };
  return { root, port, stack: toastStack(root, port) };
}
const titles = (root: HTMLElement) => [...root.querySelectorAll(".notice-title")].map((t) => t.textContent);

afterEach(() => vi.unstubAllGlobals());

describe("the corner toast window", () => {
  it("stacks toasts newest nearest the screen's edge, and keeps the window in its corner", () => {
    const { root, port, stack } = setup();
    stack.sync(state(["a", "b"]));
    expect(titles(root)).toEqual(["b", "a"]);
    expect(port.place).toHaveBeenLastCalledWith("top-right", TOAST_WIDTH + 2 * GUTTER, expect.any(Number));
    stack.sync(state(["a", "b", "c"], { corner: "bottom-left" }));
    expect(titles(root)).toEqual(["b", "a", "c"]);
    expect(root.dataset.corner).toBe("bottom-left");
    expect(port.place).toHaveBeenLastCalledWith("bottom-left", expect.any(Number), expect.any(Number));
  });

  it("places the window while it is still hidden, when the page gets no frames", () => {
    const { port, stack } = setup();
    // A hidden WebKitGTK page: frames never come.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    stack.sync(state(["a"], { corner: "bottom-left" }));
    expect(port.place).toHaveBeenCalledWith("bottom-left", TOAST_WIDTH + 2 * GUTTER, expect.any(Number));
  });

  it("tells the island what the user did", () => {
    const { root, port, stack } = setup();
    stack.sync(state(["a"]));
    root.querySelector<HTMLButtonElement>(".notice-acts button")!.click();
    root.querySelector<HTMLButtonElement>(".notice-close")!.click();
    expect(port.send.mock.calls).toEqual([[{ kind: "act", id: "a", action: "open" }], [{ kind: "close", id: "a" }]]);
  });

  it("takes off what the island no longer shows, and hides the window when none is left", async () => {
    const { root, port, stack } = setup();
    stack.sync(state(["a", "b"]));
    stack.sync(state(["b"]));
    await vi.waitFor(() => expect(titles(root)).toEqual(["b"]));
    stack.sync(state([]));
    await vi.waitFor(() => expect(port.place).toHaveBeenLastCalledWith("top-right", expect.any(Number), 0));
  });

  it("shows the time left only when the user wants it", () => {
    const { root, stack } = setup();
    stack.sync(state(["a"]));
    expect(root.querySelector(".notice-bar")).not.toBeNull();
    stack.sync(state(["a", "b"], { bar: false }));
    const b = [...root.querySelectorAll(".notice-card")].find((c) => c.querySelector(".notice-title")?.textContent === "b")!;
    expect(b.querySelector(".notice-bar")).toBeNull();
    stack.sync(state(["a", "b", "c"], { sticky: true }));
    expect(root.querySelector(".notice-card:first-child .notice-bar")).toBeNull();
  });

  it("says when its time is up, and logs when it can't place the window", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (f(0), 0));
    const root = document.createElement("div");
    const port = { place: vi.fn(async () => Promise.reject(new Error("gone"))), send: vi.fn() };
    toastStack(root, port, log).sync(state(["a"], { seconds: 2 }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(port.send).toHaveBeenCalledWith({ kind: "expire", id: "a" });
    expect(log).toHaveBeenCalledWith("[toasts] place: Error: gone");
    vi.useRealTimers();
  });
});
