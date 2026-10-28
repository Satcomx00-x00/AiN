// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { fromFreedesktop, fromWeb, fromWindows, toNotice } from "./notice-formats";

const SVG = `<path d="M2 2h12"/>`;

describe("freedesktop notifications", () => {
  it("reads Notify's arguments: actions in pairs, the urgency and the hints", () => {
    expect(
      fromFreedesktop({
        app_name: "Firefox",
        replaces_id: 7,
        app_icon: SVG,
        summary: "Download complete",
        body: "Fedora.iso",
        actions: ["default", "", "open", "Open", "dangling"],
        hints: { urgency: 2, category: "transfer.complete", transient: true },
        expire_timeout: 5000,
      }),
    ).toEqual({ title: "Download complete", body: "Fedora.iso", icon: SVG, actions: [{ id: "open", label: "Open" }], urgency: "urgent", tag: "7", category: "transfer.complete", transient: true });
  });

  it("leaves out what it doesn't give, and icons that aren't markup", () => {
    expect(fromFreedesktop({ summary: "Hi", app_icon: "mail-unread", replaces_id: 0, hints: { urgency: 0 } })).toEqual({ title: "Hi", actions: [], urgency: "low" });
    expect(fromFreedesktop({ summary: "Hi", hints: null as never })).toEqual({ title: "Hi", actions: [] });
  });
});

describe("W3C notifications", () => {
  it("reads the title and options; a silent one only goes to the history", () => {
    expect(fromWeb({ title: "Mail", options: { body: "2 new", icon: SVG, tag: "inbox", actions: [{ action: "read", title: "Read" }], silent: true, requireInteraction: true } })).toEqual({
      title: "Mail",
      body: "2 new",
      icon: SVG,
      tag: "inbox",
      actions: [{ id: "read", label: "Read" }],
      urgency: "low",
    });
    expect(fromWeb({ title: "Mail", options: { icon: "https://x/icon.png", tag: "", actions: "no" as never } })).toEqual({ title: "Mail" });
  });
});

describe("Windows toasts", () => {
  const xml = (scenario: string, more = "") => `<toast scenario="${scenario}">
    <visual><binding template="ToastGeneric"><text>Alarm</text><text>Wake up</text><text> </text><text>Now</text></binding></visual>
    <actions><action content="Snooze" arguments="snooze"/><action content="" arguments="dismiss" activationType="system"/>${more}</actions>
  </toast>`;

  it("reads its texts as the title and body, its actions as buttons and its scenario as urgency", () => {
    expect(fromWindows({ toastXml: xml("alarm"), tag: "a1", group: "clock" })).toEqual({
      title: "Alarm",
      body: "Wake up\nNow",
      actions: [{ id: "snooze", label: "Snooze" }],
      urgency: "urgent",
      tag: "clock/a1",
    });
    expect(fromWindows({ toastXml: xml("reminder", "<action/>"), tag: "a1" })).toEqual({
      title: "Alarm",
      body: "Wake up\nNow",
      actions: [{ id: "snooze", label: "Snooze" }, { id: "", label: "" }],
      tag: "a1",
    });
    expect(fromWindows({ toastXml: "<toast><visual><binding><text/></binding></visual></toast>" })).toEqual({ title: "", actions: [] });
  });

  it("refuses XML that isn't a toast", () => {
    expect(() => fromWindows({ toastXml: "<tile/>" })).toThrow("no <toast>");
    const broken = new DOMParser().parseFromString("<toast><parsererror/></toast>", "text/xml");
    expect(() => fromWindows({ toastXml: "", group: "g" }, () => broken)).toThrow("no <toast>");
  });
});

describe("any notice", () => {
  it("tells the formats apart, and passes AiN's own through", () => {
    expect(toNotice({ summary: "A" }).title).toBe("A");
    expect(toNotice({ toastXml: "<toast><visual><binding><text>B</text></binding></visual></toast>" }).title).toBe("B");
    expect(toNotice({ title: "C", options: {} })).toEqual({ title: "C" });
    const own = { title: "D", body: "d" };
    expect(toNotice(own)).toBe(own);
  });
});
