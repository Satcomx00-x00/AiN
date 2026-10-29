// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CardOptions, card } from "./notice-card";
import { normalize } from "./notifications";

const SOURCE = { id: "mail", label: "Mail", icon: "<path/>" };
const OPTIONS: CardOptions = { actions: true, largeText: false, lifetime: 4000, bar: true, animation: "none", speed: 300 };
const make = (notice: Parameters<typeof normalize>[2] = { title: "Hi", body: "There" }, o: Partial<CardOptions> = {}, at = Date.now()) => {
  const on = { close: vi.fn(), act: vi.fn(), expire: vi.fn() };
  const c = card(normalize("n1", SOURCE, notice, at), { ...OPTIONS, ...o }, on);
  document.body.replaceChildren(c.el);
  return { c, on, el: c.el };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a notification card", () => {
  it("says who sent it and when, announced politely, or at once when urgent", () => {
    const calm = make({ title: "Hi" }, { from: "left" }, Date.now() - 2 * 3_600_000);
    expect(calm.el.getAttribute("role")).toBe("status");
    expect(calm.el.dataset.from).toBe("left");
    expect(calm.el.querySelector(".notice-src")?.textContent).toMatch(/^Mail · \d/);
    expect(calm.el.querySelector(".notice-body")).toBeNull();
    const urgent = make({ title: "Battery low", urgency: "urgent" }, { largeText: true });
    expect([urgent.el.getAttribute("role"), urgent.el.dataset.from, urgent.el.className]).toEqual(["alert", "top", "notice-card large"]);
    expect(urgent.el.querySelector(".notice-src")?.textContent).toBe("Mail · now · Urgent");
  });

  it("has a large Close, and actions only when the user wants them", () => {
    const { el, on } = make({ title: "Hi", actions: [{ id: "open", label: "Open" }] });
    el.querySelector<HTMLButtonElement>(".notice-acts button")!.click();
    el.querySelector<HTMLButtonElement>(".notice-close")!.click();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect([on.act.mock.calls, on.close.mock.calls.length]).toEqual([[["open"]], 2]);
    expect(el.querySelector(".notice-close")?.getAttribute("aria-label")).toBe("Close notification: Hi");
    expect(make({ title: "Hi", actions: [{ id: "open", label: "Open" }] }, { actions: false }).el.querySelector(".notice-acts")).toBeNull();
  });

  it("expires after its time, waiting while the pointer or the keyboard is on it", async () => {
    const { el, on } = make();
    vi.advanceTimersByTime(1000);
    el.dispatchEvent(new Event("pointerenter"));
    el.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(10_000);
    expect(on.expire).not.toHaveBeenCalled();
    const hovered = vi.spyOn(el, "matches").mockReturnValue(true);
    el.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(10_000);
    expect(on.expire).not.toHaveBeenCalled();
    hovered.mockReturnValue(false);
    el.dispatchEvent(new Event("pointerleave"));
    el.dispatchEvent(new Event("focusin"));
    el.dispatchEvent(new Event("focusout"));
    vi.advanceTimersByTime(2999);
    expect(on.expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(on.expire).toHaveBeenCalledOnce();
  });

  it("stays until closed when it has no time, and shows the time left only when asked", () => {
    const sticky = make({ title: "Hi" }, { lifetime: null });
    sticky.el.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(60_000);
    expect(sticky.on.expire).not.toHaveBeenCalled();
    expect(sticky.el.querySelector(".notice-bar")).toBeNull();
    expect(make({ title: "Hi" }, { bar: false }).el.querySelector(".notice-bar")).toBeNull();
  });

  it("shows a newer version with its time started again", () => {
    const { c, on, el } = make();
    vi.advanceTimersByTime(3000);
    c.update(normalize("n1", SOURCE, { title: "Hi again" }, Date.now()));
    vi.advanceTimersByTime(3000);
    expect(on.expire).not.toHaveBeenCalled();
    expect(el.querySelector(".notice-title")?.textContent).toBe("Hi again");
  });

  it("leaves with its animation, or at once without one", async () => {
    const plain = make();
    await plain.c.leave();
    expect(plain.el.isConnected).toBe(false);
    const animated = make({ title: "Hi" }, { animation: "slide" });
    const leaving = animated.c.leave();
    expect(animated.el.dataset.leaving).toBe("true");
    animated.el.dispatchEvent(new Event("animationend"));
    await leaving;
    expect(animated.el.isConnected).toBe(false);
    const stuck = make({ title: "Hi" }, { animation: "fade" });
    const late = stuck.c.leave();
    await vi.advanceTimersByTimeAsync(350);
    await late;
    expect(stuck.el.isConnected).toBe(false);
  });
});
