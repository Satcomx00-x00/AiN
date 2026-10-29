import { describe, expect, it, vi } from "vitest";
import type { Notification } from "../sdk/notify";
import { DEFAULT_NOTIFICATIONS, HISTORY, type NotificationSettings, center, fate, inQuietHours, normalize, parseNotifications, runHooks } from "./notifications";

const MAIL = { id: "mail", label: "Mail", icon: "<path/>" };
const CHAT = { id: "chat", label: "Chat", icon: "<circle/>" };
const NOON = new Date(2026, 9, 28, 12, 0);
const with_ = (patch: Partial<NotificationSettings>): NotificationSettings => ({ ...DEFAULT_NOTIFICATIONS, ...patch });

describe("reading the settings", () => {
  it("keeps every valid field and falls back field by field", () => {
    const read = parseNotifications({ format: "toast", corner: "bottom-left", seconds: 99, bar: false, from: "25:00", muted: ["a", "a", "b"] });
    expect(read).toMatchObject({ format: "toast", corner: "bottom-left", seconds: DEFAULT_NOTIFICATIONS.seconds, bar: false, from: DEFAULT_NOTIFICATIONS.from, muted: ["a", "b"] });
    expect(parseNotifications("nope")).toEqual(DEFAULT_NOTIFICATIONS);
    expect(parseNotifications({ format: "My Notifier" }).format).toBe(DEFAULT_NOTIFICATIONS.format);
  });
});

describe("do not disturb", () => {
  it("follows daily hours, across midnight too", () => {
    const night = { schedule: true, from: "22:00", to: "07:00" };
    expect(inQuietHours(night, new Date(2026, 0, 1, 23, 30))).toBe(true);
    expect(inQuietHours(night, new Date(2026, 0, 1, 6, 59))).toBe(true);
    expect(inQuietHours(night, new Date(2026, 0, 1, 7, 0))).toBe(false);
    expect(inQuietHours({ schedule: true, from: "13:00", to: "14:00" }, new Date(2026, 0, 1, 13, 15))).toBe(true);
    expect(inQuietHours({ ...night, schedule: false }, new Date(2026, 0, 1, 23, 30))).toBe(false);
  });

  it("keeps notifications in the history, but lets urgent ones through when allowed", () => {
    const quiet = with_({ quiet: true });
    expect(fate({ source: MAIL, urgency: "normal" }, quiet, NOON)).toBe("history");
    expect(fate({ source: MAIL, urgency: "urgent" }, quiet, NOON)).toBe("show");
    expect(fate({ source: MAIL, urgency: "urgent" }, { ...quiet, urgent: false }, NOON)).toBe("history");
    expect(fate({ source: MAIL, urgency: "low" }, DEFAULT_NOTIFICATIONS, NOON)).toBe("history");
    expect(fate({ source: MAIL, urgency: "urgent" }, with_({ muted: ["mail"] }), NOON)).toBe("drop");
  });
});

describe("what plugins post", () => {
  it("is trimmed to what the island can show", () => {
    const n = normalize("n1", MAIL, { title: `  ${"t".repeat(200)}`, actions: [{ id: "a", label: "A" }, { id: "", label: "x" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }], urgency: "loud" as never }, 1);
    expect(n.title).toHaveLength(120);
    expect(n.actions.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect([n.urgency, n.icon, n.body, n.tag, n.seen]).toEqual(["normal", MAIL.icon, "", null, false]);
  });
});

describe("hooks", () => {
  const n = normalize("n1", MAIL, { title: "Hi", body: "secret" }, 1);

  it("change, quiet or drop others' notifications, in order", () => {
    const hide = { pluginId: "privacy", run: (m: Notification) => ({ ...m, body: "" }) };
    expect(runHooks(n, [hide])).toMatchObject({ id: "n1", source: MAIL, body: "" });
    expect(runHooks(n, [{ pluginId: "x", run: () => "silent" }, hide])).toBe("silent");
    expect(runHooks(n, [{ pluginId: "x", run: () => null }, hide])).toBeNull();
  });

  it("never see their own plugin's, nor change who sent it, and a failing one is skipped", () => {
    const log = vi.fn();
    const sneaky = { pluginId: "x", run: (m: Notification) => ({ ...m, id: "other", source: CHAT, title: "Changed" }) };
    expect(runHooks(n, [{ pluginId: "mail", run: () => null }])).toBe(n);
    expect(runHooks(n, [sneaky])).toMatchObject({ id: "n1", source: MAIL, title: "Changed" });
    expect(runHooks(n, [{ pluginId: "bad", run: () => { throw new Error("boom"); } }], log)).toBe(n);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`"bad" failed`));
  });
});

describe("the center", () => {
  const setup = (settings = DEFAULT_NOTIFICATIONS) => {
    const c = center(() => NOON.getTime());
    c.configure(settings);
    const events = { show: vi.fn(), update: vi.fn(), gone: vi.fn(), action: vi.fn() };
    c.listen(events);
    return { c, events };
  };

  it("shows a notification and keeps it, unseen, newest first", () => {
    const { c, events } = setup();
    c.post(MAIL, { title: "One" });
    const id = c.post(CHAT, { title: "Two" });
    expect(events.show).toHaveBeenLastCalledWith(expect.objectContaining({ id, title: "Two" }));
    expect(c.list().map((n) => n.title)).toEqual(["Two", "One"]);
    expect(c.unseen()).toBe(2);
    c.markSeen();
    expect(c.unseen()).toBe(0);
  });

  it("replaces a notification with the same tag from the same source", () => {
    const { c, events } = setup();
    const first = c.post(MAIL, { title: "1 new", tag: "inbox" });
    const second = c.post(MAIL, { title: "2 new", tag: "inbox" });
    c.post(CHAT, { title: "Other", tag: "inbox" });
    expect(second).toBe(first);
    expect(events.gone).toHaveBeenCalledWith(first);
    expect(c.list().map((n) => n.title)).toEqual(["Other", "2 new"]);
  });

  it("keeps quiet ones in the history without showing them, and drops muted sources", () => {
    const { c, events } = setup(with_({ quiet: true, muted: ["chat"] }));
    c.post(MAIL, { title: "Later" });
    c.post(CHAT, { title: "Never" });
    expect(events.show).not.toHaveBeenCalled();
    expect(c.list().map((n) => n.title)).toEqual(["Later"]);
  });

  it("closes, acts and removes", () => {
    const { c, events } = setup();
    const id = c.post(MAIL, { title: "Mail", actions: [{ id: "open", label: "Open" }] });
    c.act(id, "nope");
    expect(events.action).not.toHaveBeenCalled();
    c.act(id, "open");
    expect(events.action).toHaveBeenCalledWith(expect.objectContaining({ id }), "open");
    expect(c.list()[0]?.seen).toBe(true);
    const other = c.post(MAIL, { title: "Other" });
    c.close(other);
    expect(events.gone).toHaveBeenCalledWith(other);
    expect(c.list()).toHaveLength(2);
    c.remove(other);
    expect(c.list()).toHaveLength(1);
    c.clear();
    expect(c.list()).toEqual([]);
  });

  it("updates in place, keeping whether it was seen", () => {
    const { c, events } = setup();
    const id = c.post(MAIL, { title: "Downloading", body: "10%" });
    c.markSeen();
    c.update(id, { body: "90%" });
    expect(c.list()[0]).toMatchObject({ title: "Downloading", body: "90%", seen: true });
    expect(events.update).toHaveBeenCalledWith(expect.objectContaining({ body: "90%" }));
  });

  it("keeps a bounded history and tells watchers of every change", () => {
    const { c } = setup();
    const seen = vi.fn();
    const stop = c.watch(seen);
    for (let i = 0; i < HISTORY + 5; i++) c.post(MAIL, { title: String(i) });
    expect(c.list()).toHaveLength(HISTORY);
    expect(c.list()[0]?.title).toBe(String(HISTORY + 4));
    expect(seen).toHaveBeenCalledTimes(HISTORY + 6);
    stop();
    c.clear();
    expect(seen).toHaveBeenCalledTimes(HISTORY + 6);
  });

  it("shows a transient one without keeping it, and forgets it once it leaves", () => {
    const { c, events } = setup();
    const id = c.post(MAIL, { title: "Copied", transient: true, category: "  clipboard  " });
    expect(events.show).toHaveBeenCalledWith(expect.objectContaining({ id, transient: true, category: "clipboard" }));
    expect(c.list()).toEqual([]);
    c.update(id, { body: "Again" });
    expect(events.update).toHaveBeenCalledWith(expect.objectContaining({ body: "Again", transient: true }));
    c.expire(id);
    c.update(id, { body: "Gone" });
    expect(events.update).toHaveBeenCalledTimes(1);
  });

  it("closes, acts on and replaces transient ones without touching the history", () => {
    const { c, events } = setup();
    const a = c.post(MAIL, { title: "A", transient: true, actions: [{ id: "undo", label: "Undo" }] });
    c.act(a, "undo");
    expect(events.action).toHaveBeenCalledWith(expect.objectContaining({ id: a }), "undo");
    const b = c.post(MAIL, { title: "B", transient: true, tag: "t" });
    expect(c.post(MAIL, { title: "B2", transient: true, tag: "t" })).toBe(b);
    c.close(b);
    expect(events.gone).toHaveBeenCalledWith(b);
    const d = c.post(MAIL, { title: "D", transient: true });
    c.remove(d);
    expect(events.gone).toHaveBeenLastCalledWith(d);
    expect(c.list()).toEqual([]);
  });

  it("drops a transient one that wouldn't show", () => {
    const { c, events } = setup(with_({ quiet: true }));
    c.post(MAIL, { title: "Later", transient: true });
    c.configure(DEFAULT_NOTIFICATIONS);
    c.setHooks([{ pluginId: "x", run: () => "silent" }]);
    c.post(MAIL, { title: "Hushed", transient: true });
    expect(events.show).not.toHaveBeenCalled();
    expect(c.list()).toEqual([]);
  });

  it("lets a hook make one transient, keeping its category", () => {
    const { c, events } = setup();
    c.setHooks([{ pluginId: "x", run: (n) => ({ ...n, transient: true, category: "im.received" }) }]);
    c.post(MAIL, { title: "Hi" });
    expect(events.show).toHaveBeenCalledWith(expect.objectContaining({ transient: true, category: "im.received" }));
    expect(c.list()).toEqual([]);
  });

  it("ignores what it doesn't know, and what's already done", () => {
    const { c, events } = setup();
    c.remove("nope");
    c.close("nope");
    c.markSeen();
    const id = c.post(MAIL, { title: "A" });
    c.post(MAIL, { title: "B" });
    c.close(id);
    c.close(id);
    c.markSeen();
    expect(events.gone).toHaveBeenCalledTimes(2);
    expect(c.unseen()).toBe(0);
  });

  it("lets a hook drop one, or keep its tag when it changes it", () => {
    const { c, events } = setup();
    c.setHooks([{ pluginId: "x", run: () => null }]);
    c.post(MAIL, { title: "Dropped" });
    c.setHooks([{ pluginId: "x", run: (n) => ({ ...n, title: `${n.title}!` }) }, { pluginId: "y", run: () => undefined as never }]);
    c.post(MAIL, { title: "Kept", tag: "t" });
    expect(c.list().map((n) => [n.title, n.tag])).toEqual([["Kept!", "t"]]);
    expect(events.show).toHaveBeenCalledOnce();
  });
});

describe("notices that aren't quite right", () => {
  it("still read", () => {
    expect(normalize("n1", MAIL, { title: 3 as never, category: 5 as never }, 1)).toMatchObject({ title: "", category: null, transient: false });
    expect(normalize("n1", MAIL, {}, 1).title).toBe("");
  });
});
