// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { center } from "../../shell/notifications";
import { notifications } from ".";
import { centerPort } from "./service";

const MAIL = { id: "mail", label: "Mail", icon: "<path/>" };

function open() {
  const c = center();
  const port = centerPort(c);
  const widget = notifications.setup({ notifications: port }, {} as never);
  const root = document.createElement("div");
  widget.panel?.(root);
  const rows = () => [...root.querySelectorAll<HTMLElement>(".notice")];
  const tick = (visible: boolean, now = Date.now()) => widget.tick?.({ visible, now } as never);
  return { c, port, root, rows, tick };
}

describe("the Notifications tab", () => {
  it("lists the history, newest first, says how many are new, and is empty without any", async () => {
    const { c, root, rows } = open();
    await Promise.resolve();
    expect([root.querySelector(".empty")?.hasAttribute("hidden"), root.querySelector(".eyebrow")?.textContent]).toEqual([false, "Notifications"]);
    c.post(MAIL, { title: "One" });
    c.post(MAIL, { title: "Two", body: "body" });
    expect(rows().map((r) => r.querySelector("b")?.textContent)).toEqual(["Two", "One"]);
    expect(rows()[0]?.querySelector(".notice-text span")?.textContent).toBe("Mail · body");
    expect(rows()[1]?.querySelector(".notice-text span")?.textContent).toBe("Mail");
    expect(root.querySelector(".eyebrow")?.textContent).toBe("2 new");
  });

  it("marks them seen once shown, and keeps their times current", () => {
    vi.useFakeTimers();
    const { c, rows, tick } = open();
    c.post(MAIL, { title: "One" });
    tick(false);
    expect(c.unseen()).toBe(1);
    tick(true);
    expect(c.unseen()).toBe(0);
    tick(true, Date.now() + 5 * 60_000);
    expect(rows()[0]?.querySelector("time")?.textContent).toBe("5m");
    vi.useRealTimers();
  });

  it("removes one, presses its actions, and clears them all", () => {
    const { c, root, rows } = open();
    const acted = vi.fn();
    c.listen({ action: acted });
    c.post(MAIL, { title: "One", actions: [{ id: "open", label: "Open" }] });
    c.post(MAIL, { title: "Two" });
    rows()[1]!.querySelector<HTMLButtonElement>(".notice-action")!.click();
    expect(acted).toHaveBeenCalledWith(expect.objectContaining({ title: "One" }), "open");
    rows()[0]!.querySelector<HTMLButtonElement>(".notice-remove")!.click();
    expect(c.list().map((n) => n.title)).toEqual(["One"]);
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Clear all")!.click();
    expect(rows()).toEqual([]);
  });

  it("stops following the history when asked", async () => {
    const { c, port } = open();
    const seen = vi.fn();
    const stop = await port.watch(seen);
    stop();
    c.post(MAIL, { title: "Later" });
    expect(seen).toHaveBeenCalledOnce();
    expect(port.list()).toHaveLength(1);
  });
});
