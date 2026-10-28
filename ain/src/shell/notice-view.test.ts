// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notifier } from "../sdk/notify";
import { type ToastEvent, type ToastPort, MAX_BUBBLES, noToasts, noticeView } from "./notice-view";
import { DEFAULT_NOTIFICATIONS, type NotificationSettings, center } from "./notifications";

const MAIL = { id: "mail", label: "Mail", icon: "<path/>" };
const COLORS = { bg: "#000000", fg: "#ffffff", accent: "#0a84ff" };
const fast: Partial<NotificationSettings> = { animation: "none", seconds: 2 };

/** A toast window that records what it's told and lets the test press its buttons. */
function fakeToasts() {
  let send: (e: ToastEvent) => void = () => {};
  const stop = vi.fn();
  const port = {
    sync: vi.fn<ToastPort["sync"]>(async () => {}),
    listen: vi.fn<ToastPort["listen"]>(async (onEvent) => ((send = onEvent), stop)),
  };
  return { port, stop, send: (e: ToastEvent) => send(e), shown: () => port.sync.mock.calls.at(-1)?.[0].notices.map((n) => n.title) };
}

function setup(patch: Partial<NotificationSettings> = {}, notifiers: Notifier[] = [], toasts = fakeToasts()) {
  const island = document.createElement("div");
  const surface = document.createElement("div");
  island.append(surface);
  document.body.replaceChildren(island);
  const c = center();
  const hooks = { widen: vi.fn(), regions: vi.fn(), unseen: vi.fn() };
  const log = vi.fn();
  const view = noticeView(island, surface, c, toasts.port, hooks, log);
  const settings = { ...DEFAULT_NOTIFICATIONS, ...fast, ...patch };
  view.configure(settings, notifiers, COLORS);
  const post = (title: string, more = {}) => c.post(MAIL, { title, ...more });
  const titles = () => [...island.querySelectorAll(".bubbles .notice-title")].map((t) => t.textContent);
  return { island, surface, c, hooks, log, view, toasts, post, titles, settings };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (f(0), 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the unseen dot", () => {
  it("shows while some are unseen, says how many, and tells the island", () => {
    const { island, c, hooks, post } = setup();
    const dot = island.querySelector(".unseen-dot")!;
    expect([island.dataset.unseen, dot.getAttribute("aria-label")]).toEqual(["false", "0 unseen notifications"]);
    post("One");
    expect([island.dataset.unseen, dot.getAttribute("aria-label")]).toEqual(["true", "1 unseen notification"]);
    c.markSeen();
    expect(hooks.unseen).toHaveBeenLastCalledWith(0);
  });

  it("goes without a hook to tell, or a toast window", async () => {
    expect(await noToasts.listen(() => {})).toBeTypeOf("function");
    await expect(noToasts.sync({ notices: [], settings: DEFAULT_NOTIFICATIONS, colors: COLORS })).resolves.toBeUndefined();
    const island = document.createElement("div");
    const view = noticeView(island, island, center(), noToasts, { widen: vi.fn(), regions: vi.fn() });
    expect(island.dataset.unseen).toBe("false");
    view.destroy();
  });
});

describe("in the pill", () => {
  it("widens the pill for one at a time, each for the chosen time", () => {
    const { island, c, hooks, post } = setup({ format: "pill" });
    const expire = vi.spyOn(c, "expire");
    post("One", { body: "first" });
    post("Two");
    expect(island.querySelector(".notice-inline")?.textContent).toBe("Onefirst");
    expect([island.dataset.notice, hooks.widen.mock.calls.at(-1)]).toEqual(["true", [true]]);
    vi.advanceTimersByTime(2000);
    expect(island.querySelector(".notice-inline")?.textContent).toBe("Two");
    expect(expire).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect([island.dataset.notice, hooks.widen.mock.calls.at(-1), island.querySelector(".notice-inline")?.textContent]).toEqual(["false", [false], ""]);
  });

  it("keeps one until the island opens when they stay until closed, and follows changes", () => {
    const { island, c, view, post } = setup({ format: "pill", sticky: true });
    const id = post("Downloading");
    const queued = post("Queued");
    c.update(id, { title: "Downloaded" });
    vi.advanceTimersByTime(60_000);
    expect(island.querySelector(".notice-inline b")?.textContent).toBe("Downloaded");
    c.remove(queued);
    view.setOpen(true);
    expect(c.list().find((n) => n.id === id)?.seen).toBe(true);
    expect(island.dataset.notice).toBe("false");
    view.setOpen(false);
  });
});

describe("bubbles", () => {
  it("leave once their time is up, and give back the input they took", async () => {
    const { island, hooks, post, titles } = setup({ max: 5 });
    vi.spyOn(island.querySelector(".bubbles")!, "getBoundingClientRect").mockReturnValue({ left: 10, top: 40, width: 300, height: 60 } as DOMRect);
    for (const t of ["1", "2", "3", "4"]) post(t);
    await vi.runAllTimersAsync();
    expect(titles()).toEqual([]);
    expect(hooks.regions).toHaveBeenLastCalledWith([]);
  });

  it("drops the oldest beyond the most the window has room for", async () => {
    const { island, hooks, post, titles } = setup({ max: 5, sticky: true });
    const box = vi.spyOn(island.querySelector(".bubbles")!, "getBoundingClientRect").mockReturnValue({ left: 10, top: 40, width: 300, height: 60 } as DOMRect);
    for (const t of ["1", "2", "3", "4"]) post(t);
    await vi.advanceTimersByTimeAsync(0);
    expect(titles()).toEqual(["4", "3", "2"].slice(0, MAX_BUBBLES));
    expect(hooks.regions).toHaveBeenLastCalledWith([{ x: 10, y: 40, width: 300, height: 60 }]);
    box.mockReturnValue({ left: 0, top: 0, width: 0, height: 0 } as DOMRect);
    post("5");
    expect(hooks.regions).toHaveBeenLastCalledWith([]);
  });

  it("closes, acts and follows changes; open, they step aside", async () => {
    const { island, c, view, hooks, post, titles } = setup({ sticky: true, side: "left", animation: "slide" });
    const id = post("Mail", { actions: [{ id: "open", label: "Open" }] });
    const card = island.querySelector<HTMLElement>(".notice-card")!;
    expect(card.dataset.anim).toBe("slide");
    expect(card.dataset.from).toBe("right");
    c.update(id, { title: "Mail (2)" });
    expect(titles()).toEqual(["Mail (2)"]);
    c.update("nope", { title: "x" });
    view.setOpen(true);
    expect(hooks.regions).toHaveBeenLastCalledWith([]);
    view.setOpen(false);
    island.querySelector<HTMLButtonElement>(".notice-acts button")!.click();
    await vi.runAllTimersAsync();
    expect(titles()).toEqual([]);
    post("Other");
    island.querySelector<HTMLButtonElement>(".notice-close")!.click();
    await vi.runAllTimersAsync();
    expect(titles()).toEqual([]);
  });

  it("drops from under the pill, and slides out of its side", () => {
    const center_ = setup({ animation: "slide", side: "center" });
    center_.post("A");
    expect(center_.island.querySelector<HTMLElement>(".notice-card")?.dataset.anim).toBe("drop");
    const right = setup({ animation: "fade", side: "right" });
    right.post("B");
    expect(right.island.querySelector<HTMLElement>(".notice-card")?.dataset).toMatchObject({ anim: "fade", from: "left" });
  });

  it("forgets a transient one once its time is up", async () => {
    const { c, post, titles } = setup();
    const expire = vi.spyOn(c, "expire");
    const id = post("Copied", { transient: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(expire).toHaveBeenCalledWith(id);
    expect(titles()).toEqual([]);
  });
});

describe("a plugin's notifier", () => {
  const ticker = (overrides: Partial<Notifier> = {}): Notifier & { cleanup: ReturnType<typeof vi.fn> } => {
    const cleanup = vi.fn();
    return {
      id: "ticker",
      label: "Ticker",
      cleanup,
      show: vi.fn((stage: HTMLElement, n) => {
        stage.textContent = n.title;
        return cleanup;
      }),
      ...overrides,
    };
  };

  it("draws where bubbles go, for the chosen time", async () => {
    const t = ticker();
    const { island, post } = setup({ format: "ticker" }, [t]);
    post("Hello");
    expect(island.querySelector(".notifier-stage")?.textContent).toBe("Hello");
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.cleanup).toHaveBeenCalled();
    expect(island.querySelector(".notifier-stage")).toBeNull();
  });

  it("can dismiss and act, and stays until then when they stay until closed", async () => {
    let ctx: Parameters<Notifier["show"]>[2] | undefined;
    const t = ticker({ show: (_s, _n, given) => void (ctx = given) });
    const { island, c, post } = setup({ format: "ticker", sticky: true }, [t]);
    const act = vi.spyOn(c, "act");
    const id = post("Hello", { actions: [{ id: "go", label: "Go" }] });
    ctx!.act("go");
    expect(act).toHaveBeenCalledWith(id, "go");
    post("Again");
    ctx!.dismiss();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(island.querySelectorAll(".notifier-stage")).toHaveLength(0);
  });

  it("is logged, not fatal, when it fails", async () => {
    const t = ticker({
      show: () => {
        throw new Error("boom");
      },
    });
    const { log, post } = setup({ format: "ticker" }, [t]);
    post("Hello");
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`notifier "ticker" failed`));
    const bad = ticker();
    bad.cleanup.mockImplementation(() => {
      throw new Error("bad");
    });
    const second = setup({ format: "ticker" }, [bad]);
    second.post("Hi");
    await vi.advanceTimersByTimeAsync(2000);
    expect(second.log).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
  });
});

describe("corner toasts", () => {
  it("sends the window the latest ones, as many as allowed, and follows changes", () => {
    const { toasts, c, post, settings } = setup({ format: "toast", max: 2 });
    expect(toasts.port.sync).toHaveBeenLastCalledWith({ notices: [], settings, colors: COLORS });
    const a = post("A");
    post("B");
    post("C");
    expect(toasts.shown()).toEqual(["B", "C"]);
    c.update(a, { title: "A2" });
    const b = c.list()[1]!.id;
    c.update(b, { title: "B2" });
    expect(toasts.shown()).toEqual(["B2", "C"]);
  });

  it("hears what the user did there", () => {
    const { toasts, c, post } = setup({ format: "toast" });
    const [act, close, expire] = [vi.spyOn(c, "act"), vi.spyOn(c, "close"), vi.spyOn(c, "expire")];
    const a = post("A", { actions: [{ id: "go", label: "Go" }] });
    const b = post("B");
    const d = post("D");
    toasts.send({ kind: "act", id: a, action: "go" });
    toasts.send({ kind: "close", id: b });
    toasts.send({ kind: "expire", id: d });
    toasts.send({ kind: "expire", id: "gone" });
    expect([act.mock.calls, close.mock.calls, expire.mock.calls.map(([id]) => id)]).toEqual([[[a, "go"]], [[b]], [d, "gone"]]);
    expect(toasts.shown()).toEqual([]);
  });

  it("logs when the window can't be reached", async () => {
    const toasts = fakeToasts();
    toasts.port.sync.mockRejectedValue(new Error("no window"));
    toasts.port.listen.mockRejectedValue(new Error("no events"));
    const { log } = setup({ format: "toast" }, [], toasts);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.mock.calls.map(([m]) => m)).toEqual(expect.arrayContaining(["[notifications] toasts: Error: no window", "[notifications] toasts: Error: no events"]));
  });
});

describe("changing the settings", () => {
  it("takes off what shows when the format or its place changes", async () => {
    const s = setup({ sticky: true });
    s.post("Bubble");
    s.view.configure({ ...s.settings, side: "right" }, [], COLORS);
    await vi.runAllTimersAsync();
    expect(s.titles()).toEqual([]);
    expect(s.island.querySelector<HTMLElement>(".bubbles")?.dataset.side).toBe("right");
    s.view.configure({ ...s.settings, side: "right", format: "toast" }, [], COLORS);
    s.post("Toast");
    s.view.configure({ ...s.settings, side: "right", format: "toast", corner: "bottom-left" }, [], COLORS);
    expect(s.toasts.shown()).toEqual([]);
    s.view.configure({ ...s.settings, side: "right", format: "toast", corner: "bottom-left", speed: "slow" }, [], COLORS);
    expect(s.island.style.getPropertyValue("--nc-anim")).toBe("500ms");
  });

  it("cleans up when destroyed, whether the toast window answered yet or not", async () => {
    const s = setup({ format: "pill" });
    s.post("Inline");
    s.view.configure({ ...s.settings, format: "bubble", sticky: true }, [], COLORS);
    s.post("Bubble");
    await vi.advanceTimersByTimeAsync(0);
    s.view.destroy();
    expect(s.toasts.stop).toHaveBeenCalled();
    expect(s.island.querySelector(".bubbles, .unseen-dot, .notice-inline")).toBeNull();
    const pending = fakeToasts();
    pending.port.listen.mockReturnValue(new Promise(() => {}));
    setup({}, [], pending).view.destroy();
  });
});
