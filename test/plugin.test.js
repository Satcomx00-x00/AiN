// Runs the plugin the way AiN does, against a fake SDK and a fake Google Calendar.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import make from "../index.js";

/** The parts of AiN's SDK the plugin uses: see "The SDK" in docs/plugins.md. */
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};
const option = (kind) => (label, value) => ({ kind, label, default: value });
const island = {
  dom: {
    h,
    button: (label, onClick, attrs = {}) => {
      const b = h("button", { type: "button", ...attrs }, label);
      b.addEventListener("click", onClick);
      return b;
    },
  },
  options: { text: option("text"), list: option("list"), number: option("number"), choice: option("choice"), toggle: option("toggle") },
  definePlugin: (p) => p,
};
const plugin = make(island);

const DAY = 24 * 3600_000;
const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
const at = (hour) => new Date(today + hour * 3600_000).toISOString();
const isoDate = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A fake Calendar API: two calendars and a standup today; it records what it is asked. */
let calls;
let token;
let mine;
const standup = { id: "standup1", summary: "Standup", start: { dateTime: at(10) }, end: { dateTime: at(11) } };
const answer = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const google = async (url, init = {}) => {
  const path = decodeURIComponent(new URL(url).pathname.replace("/calendar/v3", ""));
  const method = init.method ?? "GET";
  calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
  if (path === "/users/me/calendarList")
    return answer({
      items: [
        { id: "holidays", summary: "Holidays", accessRole: "reader", backgroundColor: "#f691b2" },
        { id: "me@example.com", summary: "Me", primary: true, accessRole: "owner", backgroundColor: "#9fe1e7" },
      ],
    });
  if (path === "/colors") return answer({ event: {} });
  if (path === "/calendars/me@example.com/events" && method === "GET") return answer({ items: mine });
  if (path.endsWith("/events") && method === "GET") return answer({ items: [] });
  if (path.endsWith("/events/standup1") && method === "GET") return answer(standup);
  if (method === "POST") {
    const made = { id: "new1", ...JSON.parse(init.body) };
    mine.push(made);
    return answer(made);
  }
  if (method === "DELETE") {
    mine = mine.filter((e) => !path.endsWith(`/events/${e.id}`));
    return answer(null, 204);
  }
  return answer({ error: { message: "not found" } }, 404);
};

/** AiN's host for a page: the plugin's options, what it was opened on, its title, closing it. */
const hostFor = (params = {}) => {
  const set = {};
  const defaults = Object.fromEntries(Object.entries(plugin.options).map(([k, o]) => [k, o.default]));
  const host = {
    params,
    title: "",
    closed: false,
    changes: [],
    options: () => ({ ...defaults, clientId: "id", clientSecret: "secret", ...set }),
    setOptions: (o) => {
      host.changes.push(o);
      Object.assign(set, o);
    },
    setTitle: (t) => (host.title = t),
    close: () => (host.closed = true),
    openPage() {},
    openSettings() {},
  };
  return host;
};
const oauth = { token: async () => token, signedIn: async () => token !== null, signIn: async () => {}, signOut: async () => {} };

/** Lets the fake API answer and the page draw. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const press = (key) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const byLabel = (label) => document.querySelector(`[aria-label="${label}"]`);
const toast = () => document.querySelector(".gc-toast");
const undo = () => [...toast().querySelectorAll("button")].find((b) => b.textContent === "Undo");

let root;
let cleanup;
const open = async (params) => {
  const host = hostFor(params);
  cleanup = plugin.page(root, { oauth }, host);
  await settle();
  return host;
};

beforeEach(() => {
  calls = [];
  token = "a-token";
  mine = [standup];
  globalThis.fetch = google;
  root = h("div", { class: "plugin-page" });
  document.body.replaceChildren(root);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("the plugin", () => {
  test("signs in with oauth and asks for a taller tab and a page of its own", () => {
    expect(plugin.id).toBe("google-calendar");
    expect(plugin.needs).toEqual(["oauth"]);
    expect(plugin.panelHeight).toBe(340);
    expect(typeof plugin.page).toBe("function");
    expect(plugin.options.pageView.default).toBe("week");
  });
});

describe("the calendar page", () => {
  test("names the window and shows the week, the calendars and their events", async () => {
    const host = await open();
    expect(host.title).toBe("Calendar");
    expect(document.querySelectorAll(".gc-dh")).toHaveLength(7);
    expect([...document.querySelectorAll(".gc-cal")].map((c) => c.textContent)).toEqual(["Me", "Holidays"]);
    expect(document.querySelector('.gc-ev[data-id="standup1"] b')?.textContent).toBe("Standup");
    expect(calls.every((c) => c.auth === "Bearer a-token")).toBe(true);
  });

  test("switches views with Google Calendar's keys, and remembers the view", async () => {
    const host = await open();
    press("m");
    await settle();
    expect(document.querySelector(".gc-month")).not.toBeNull();
    expect(host.options().pageView).toBe("month");
    press("d");
    await settle();
    expect(document.querySelectorAll(".gc-dh")).toHaveLength(1);
    press("x");
    await settle();
    expect(document.querySelectorAll(".gc-dh")).toHaveLength(4);
  });

  test("opened on hours dragged in the island, creates the event there, with Undo", async () => {
    const date = isoDate(today + DAY);
    await open({ date, start: "09:00", end: "10:30" });
    const editor = byLabel("New event");
    expect(editor).not.toBeNull();
    expect(document.querySelector(".gc-draft")).not.toBeNull();
    editor.querySelector(".gc-title-in").value = "Dentist";
    editor.querySelector(".gc-save").click();
    await settle();
    const post = calls.find((c) => c.method === "POST");
    expect(post.path).toBe("/calendars/primary/events");
    expect(post.body.summary).toBe("Dentist");
    expect(post.body.start.dateTime).toBe(new Date(`${date}T09:00`).toISOString());
    expect(post.body.end.dateTime).toBe(new Date(`${date}T10:30`).toISOString());
    expect(post.body.start.date).toBeUndefined();
    expect(byLabel("New event")).toBeNull();
    expect(toast().textContent).toContain("“Dentist” saved");
    click(undo());
    await settle();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/calendars/primary/events/new1")).toBe(true);
  });

  test("won't save an event that ends before it starts", async () => {
    await open({ date: isoDate(today), start: "09:00", end: "10:00" });
    const editor = byLabel("New event");
    editor.querySelector('[aria-label="End time"]').value = "08:00";
    editor.querySelector(".gc-save").click();
    await settle();
    expect(editor.querySelector(".gc-failed").textContent).toBe("It has to end after it starts.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("opened on an event from the island, shows its details; deleting it can be undone", async () => {
    await open({ calendar: "primary", event: "standup1" });
    const details = byLabel("Standup");
    expect(details?.classList.contains("gc-pop")).toBe(true);
    click(details.querySelector('[aria-label="Delete event"]'));
    await settle();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/calendars/me@example.com/events/standup1")).toBe(true);
    expect(document.querySelector('.gc-ev[data-id="standup1"]')).toBeNull();
    expect(toast().textContent).toContain("“Standup” deleted");
    click(undo());
    await settle();
    const post = calls.find((c) => c.method === "POST");
    expect(post.path).toBe("/calendars/me@example.com/events");
    expect(post.body).toMatchObject({ summary: "Standup", start: standup.start, end: standup.end });
  });

  test("Escape closes the popup", async () => {
    await open({ calendar: "primary", event: "standup1" });
    expect(byLabel("Standup")).not.toBeNull();
    press("Escape");
    expect(byLabel("Standup")).toBeNull();
  });

  test("signed out, says so and leads back to Settings", async () => {
    token = null;
    const host = await open();
    expect(document.querySelector(".gc-message")?.textContent).toContain("You're signed out of Google.");
    click([...document.querySelectorAll(".gc-message button")].find((b) => b.textContent === "Back to Settings"));
    expect(host.closed).toBe(true);
  });

  test("closed, stops listening to the keyboard", async () => {
    const host = await open();
    cleanup();
    cleanup = undefined;
    press("m");
    await settle();
    expect(host.changes).toEqual([]);
  });
});
