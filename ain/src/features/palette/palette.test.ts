// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandInfo } from "../../sdk/plugin";
import type { ClipboardPort } from "../clipboard/service";
import { calculate, plain, pretty } from "./calc";
import { best, fuzzy, startsWord } from "./fuzzy";
import { type Item, parseQuery, rank } from "./items";
import { appsProvider, asLink, commandsProvider, filesProvider, systemProvider, trashTitle, webProvider } from "./providers";
import { type Recent, localRecent, recentIn } from "./recent";
import { type App, type Hit, type PalettePort, idlePalette } from "./service";
import { SELF, highlight, paletteView } from "./view";

const { palette } = await import(".");

beforeEach(() => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  document.body.replaceChildren();
});
afterEach(() => vi.restoreAllMocks());

/** Remembers nothing. */
const forgetful: Recent = { boost: () => 0, note: () => {}, keys: () => [] };

describe("fuzzy matching", () => {
  it("prefers the start of the text, then the start of a word, then anywhere", () => {
    const start = fuzzy("fire", "Fire Fox")!.score;
    const word = fuzzy("fox", "Fire Fox")!.score;
    const inside = fuzzy("ire", "Fire Fox")!.score;
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(fuzzy("fire", "Firefox")!.hits).toEqual([0, 1, 2, 3]);
  });

  it("finds every word in any order, initials, and letters in order", () => {
    expect(fuzzy("code studio", "Visual Studio Code")?.hits).toEqual([7, 8, 9, 10, 11, 12, 14, 15, 16, 17]);
    expect(fuzzy("vsc", "Visual Studio Code")?.hits).toEqual([0, 7, 14]);
    expect(fuzzy("vscode", "Visual Studio Code")).not.toBeNull();
    expect(fuzzy("zz", "Visual Studio Code")).toBeNull();
    expect(fuzzy("  ", "Anything")).toBeNull();
  });

  it("ranks a piece above initials above loose letters, and shorter texts first", () => {
    const piece = fuzzy("term", "Terminal")!.score;
    const initials = fuzzy("gt", "GNOME Terminal")!.score;
    const loose = fuzzy("tml", "Terminal")!.score;
    expect(piece).toBeGreaterThan(initials);
    expect(initials).toBeGreaterThan(loose);
    expect(fuzzy("term", "Terminal")!.score).toBeGreaterThan(fuzzy("term", "Terminal Emulator Deluxe")!.score);
  });

  it("knows where words start, camel case included", () => {
    expect([0, 3, 6].map((i) => startsWord("my-AppName", i))).toEqual([true, true, true]);
    expect(startsWord("my-AppName", 4)).toBe(false);
  });

  it("weighs hidden keywords below the title", () => {
    expect(best("browser", "Firefox", "Web Browser")!.score).toBeLessThan(best("firefox", "Firefox", "Web Browser")!.score);
    expect(best("browser", "Firefox", "Web Browser")!.hits).toEqual([]);
    expect(best("nothing", "Firefox", "Web Browser")).toBeNull();
  });
});

describe("the calculator", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["2 ^ 3 ^ 2", 512],
    ["-2 ^ 2", -4],
    ["2 ** 10", 1024],
    ["10 % 3", 1],
    ["200 * 15%", 30],
    ["5!", 120],
    ["sqrt(16) + abs(-2)", 6],
    ["max(1, 7, 3)", 7],
    ["log(100)", 2],
    ["log(8, 2)", 3],
    ["2pi", 2 * Math.PI],
    ["3(1 + 2)", 9],
    ["0x1F + 1", 32],
    ["12,5 * 2", 25],
    ["1e3 / 4", 250],
    ["6 × 7 ÷ 2", 21],
    ["0.1 + 0.2", 0.30000000000000004],
    ["deg(pi)", 180],
    ["rad(180)", Math.PI],
    ["5 - 2", 3],
    ["+2 * 3", 6],
    ["10 % (4)", 2],
  ])("works out %s", (input, value) => expect(calculate(input)).toBeCloseTo(value, 10));

  it.each(["", "42", "-5", "pi", "e", "firefox", "1 +", "(1 + 2", "max(", "2 / 0", "171!", "1.5!", "sqrt(1, 2)", "x".repeat(300), "alert(1)", "2 $ 3", "(2))", "2 * )", "max()", "max(1, 2"])(
    "leaves %j alone",
    (input) => expect(calculate(input)).toBeNull(),
  );

  it("survives deep nesting without overflowing the stack", () => {
    expect(calculate(`${"(".repeat(90)}1+1${")".repeat(90)}`)).toBeNull();
    expect(calculate(`${"(".repeat(20)}1+1${")".repeat(20)}`)).toBe(2);
  });

  it("copies plain digits and shows them in the user's language", () => {
    expect(plain(0.1 + 0.2)).toBe("0.3");
    expect(pretty(1234.5, "en-US")).toBe("1,234.5");
    expect(pretty(0.1 + 0.2, "en-US")).toBe("0.3");
    // In the language asked for, as this runtime writes it (some ship English only).
    expect(pretty(1234.5, "fr-FR")).toBe(new Intl.NumberFormat("fr-FR").format(1234.5));
  });
});

describe("what is typed", () => {
  it.each([
    ["firefox", "all", "firefox"],
    ["  > ls -la ", "shell", "ls -la"],
    ["?weather paris", "web", "weather paris"],
    ["= 2 + 2", "calc", "2 + 2"],
    ["~/Doc", "path", "~/Doc"],
    ["~", "path", "~"],
    ["/etc/hosts", "path", "/etc/hosts"],
    ["C:\\Users\\", "path", "C:\\Users\\"],
    ["~notes", "all", "~notes"],
  ])("%j is a %s query for %j", (raw, mode, text) => expect(parseQuery(raw)).toEqual({ mode, text }));

  it("recognises links, and file names that only look like them", () => {
    expect(asLink("https://example.com/a b")).toBeNull();
    expect(asLink("https://example.com/x?y=1")).toEqual({ url: "https://example.com/x?y=1", typed: true });
    expect(asLink("github.com/anthropics")).toEqual({ url: "https://github.com/anthropics", typed: false });
    expect(asLink("localhost:3000")).toBeNull();
    expect(asLink("report.pdf")).toBeNull();
    expect(asLink("notes")).toBeNull();
  });
});

const item = (key: string, score: number): Item => ({ key, kind: "app", title: key, subtitle: "", hits: [], score, primary: { label: "Open", run: async () => {} } });

describe("ranking", () => {
  it("puts the best first, lifts what was used, and shows each item once", () => {
    const recent = recentIn(null);
    recent.note("b");
    expect(rank([item("a", 100), item("b", 50), item("a", 10)], forgetful).map((i) => i.key)).toEqual(["a", "b"]);
    expect(rank([item("a", 100), item("b", 50)], recent).map((i) => i.key)).toEqual(["b", "a"]);
  });

  it("remembers uses in storage, fading with time, and survives storage that fails", () => {
    let now = 0;
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const recent = recentIn(storage, () => now);
    recent.note("app:firefox");
    recent.note("app:firefox");
    now = 10;
    recent.note("app:files");
    expect(recentIn(storage, () => now).keys()).toEqual(["app:files", "app:firefox"]);
    const fresh = recentIn(storage, () => now).boost("app:firefox");
    now = 30 * 86_400_000;
    expect(recentIn(storage, () => now).boost("app:firefox")).toBeLessThan(fresh);
    expect(recentIn(storage, () => now).boost("never")).toBe(0);
    const broken = { getItem: () => "{not json", setItem: () => { throw new Error("full"); } };
    expect(() => recentIn(broken).note("x")).not.toThrow();
  });
});

describe("the providers", () => {
  it("asks before the final system actions only when the settings say so", async () => {
    const run = (confirm: boolean) => systemProvider(idlePalette, () => confirm, forgetful).search({ mode: "all", text: "shut" }) as Item[];
    expect(run(true)[0]).toMatchObject({ title: "Shut down", confirm: "Press Enter again to shut down" });
    expect(run(false)[0]?.confirm).toBeUndefined();
    const lock = systemProvider(idlePalette, () => true, forgetful).search({ mode: "all", text: "lock" }) as Item[];
    expect(lock[0]?.confirm).toBeUndefined();
  });

  it("searches files from two characters, and browses a typed path", async () => {
    const asked: string[] = [];
    const hit: Hit = { path: "/home/me/Documents", name: "Documents", folder: "~", dir: true };
    const port: PalettePort = {
      ...idlePalette,
      files: async (q) => (asked.push(`files ${q}`), [hit]),
      browse: async (p) => (asked.push(`browse ${p}`), [hit]),
    };
    const files = filesProvider(port, () => true);
    expect(await files.search({ mode: "all", text: "d" })).toEqual([]);
    const [found] = await files.search({ mode: "all", text: "docu" });
    expect(found).toMatchObject({ kind: "folder", title: "Documents", complete: "/home/me/Documents/", hits: [0, 1, 2, 3] });
    await files.search({ mode: "path", text: "~/Doc" });
    expect(asked).toEqual(["files docu", "browse ~/Doc"]);
    expect(await filesProvider(port, () => false).search({ mode: "all", text: "docu" })).toEqual([]);
  });
});

describe("highlight", () => {
  it("marks the matched characters", () => {
    const root = document.createElement("span");
    root.append(...highlight("Firefox", [0, 1, 4]));
    expect(root.innerHTML).toBe("<mark>Fi</mark>re<mark>f</mark>ox");
  });
});

describe("the palette popup", () => {
  const apps: App[] = [
    { id: "firefox", name: "Firefox", keywords: "Web Browser", detail: "Browse the web" },
    { id: "files", name: "Files", keywords: "File manager", detail: "Access and organize files" },
    { id: "calc", name: "Calculator", keywords: "", detail: "Accessories" },
  ];
  const commands: CommandInfo[] = [
    { id: "clipboard.history", label: "Clipboard history", description: "Pick a copied text", icon: "", shortcut: "Super+Shift+KeyB" },
    { id: SELF, label: "Command palette", description: "", icon: "", shortcut: null },
  ];

  async function open(options: { confirm?: boolean; failLaunch?: unknown; files?: boolean; engine?: string; port?: Partial<PalettePort> } = {}) {
    const did: string[] = [];
    const port: PalettePort = {
      ...idlePalette,
      apps: async () => apps,
      launch: async (id) => {
        if (options.failLaunch !== undefined) throw options.failLaunch;
        did.push(`launch ${id}`);
      },
      system: async (action) => void did.push(`system ${action}`),
      run: async (command) => void did.push(`run ${command}`),
      openUrl: async (url) => void did.push(`url ${url}`),
      open: async (path) => void did.push(`open ${path}`),
      reveal: async (path) => void did.push(`reveal ${path}`),
      ...options.port,
    };
    const clipboard: ClipboardPort = { history: async () => [], copy: async (t) => void did.push(`copy ${t}`), copyImage: async () => {}, clear: async () => {} };
    const ctx = {
      services: { palette: port, clipboard },
      options: () => ({ files: options.files ?? false, engine: options.engine ?? "qwant", confirm: options.confirm ?? true }),
      close: vi.fn(),
      paste: async () => {},
      commands: () => commands,
      run: async (id: string) => void did.push(`command ${id}`),
      openSettings: async () => void did.push("settings"),
      quit: async () => void did.push("quit"),
    };
    const root = document.createElement("div");
    document.body.append(root);
    const view = paletteView(root, ctx, forgetful);
    view.show();
    // The apps arrive after the first drawing.
    await new Promise((r) => setTimeout(r));
    const search = root.querySelector<HTMLInputElement>(".pk-search")!;
    const type = async (text: string) => {
      search.value = text;
      search.dispatchEvent(new Event("input"));
      await new Promise((r) => setTimeout(r));
    };
    const key = (init: KeyboardEventInit) => search.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    const titles = () => [...root.querySelectorAll(".pl-title")].map((t) => t.textContent);
    return { root, ctx, did, search, type, key, titles, footer: () => root.querySelector(".pk-foot")?.textContent ?? "" };
  }

  it("finds apps and the app's commands, but not itself, and starts the first on Enter", async () => {
    const p = await open();
    await p.type("fi");
    expect(p.titles().slice(0, 2)).toEqual(["Files", "Firefox"]);
    await p.type("palette");
    expect(p.titles()).not.toContain("Command palette");
    await p.type("firefox");
    expect(p.titles()[0]).toBe("Firefox");
    p.key({ key: "Enter" });
    await vi.waitFor(() => expect(p.ctx.close).toHaveBeenCalled());
    expect(p.did).toEqual(["launch firefox"]);
  });

  it("shows a command's shortcut and runs it, leaving the window to the command", async () => {
    const p = await open();
    await p.type("clipboard");
    expect(p.root.querySelector(".pl-keys")?.textContent).toBe("WinShiftB");
    p.key({ key: "Enter" });
    await vi.waitFor(() => expect(p.did).toEqual(["command clipboard.history"]));
    expect(p.ctx.close).not.toHaveBeenCalled();
  });

  it("works out a calculation first and copies its result", async () => {
    const p = await open();
    await p.type("12 * (3 + 4)");
    expect(p.titles()[0]).toBe("= 84");
    p.key({ key: "Enter" });
    await vi.waitFor(() => expect(p.did).toEqual(["copy 84"]));
  });

  it("runs a command line after >, and searches the chosen engine after ?", async () => {
    const p = await open();
    await p.type("> echo hi");
    expect(p.root.querySelector(".pl-mode")?.textContent).toBe("Terminal");
    p.key({ key: "Enter" });
    await vi.waitFor(() => expect(p.did).toEqual(["run echo hi"]));
    await p.type("?café crème");
    p.key({ key: "Enter" });
    await vi.waitFor(() => expect(p.did.at(-1)).toBe("url https://www.qwant.com/?q=caf%C3%A9%20cr%C3%A8me"));
  });

  it("asks before shutting down, and Esc takes the question back", async () => {
    const p = await open();
    await p.type("shut down");
    p.key({ key: "Enter" });
    expect(p.root.querySelector(".pl-ask")?.textContent).toBe("Press Enter again to shut down");
    expect(p.did).toEqual([]);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    p.search.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(p.root.querySelector(".pl-ask")).toBeNull();
    p.key({ key: "Enter" });
    p.key({ key: "Enter" });
    await vi.waitFor(() => expect(p.did).toEqual(["system shutDown"]));
  });

  it("says what went wrong and stays open", async () => {
    const p = await open({ failLaunch: "This app is no longer installed." });
    await p.type("firefox");
    p.key({ key: "Enter" });
    await vi.waitFor(() => expect(p.root.querySelector(".pl-problem")?.textContent).toBe("This app is no longer installed."));
    expect(p.ctx.close).not.toHaveBeenCalled();
  });

  it("moves the selection with the arrows and names what Enter does", async () => {
    const p = await open();
    await p.type("fi");
    expect(p.footer()).toContain("Open");
    p.key({ key: "ArrowDown" });
    const selected = p.root.querySelector("[aria-selected=true] .pl-title")?.textContent;
    expect(selected).toBe("Firefox");
    expect(p.search.getAttribute("aria-activedescendant")).toBe("pl-1");
    p.key({ key: "ArrowUp" });
    expect(p.search.getAttribute("aria-activedescendant")).toBe("pl-0");
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    p.search.dispatchEvent(tab);
    expect([tab.defaultPrevented, p.search.value]).toEqual([true, "fi"]);
  });

  it("says what an error says", async () => {
    const p = await open({ failLaunch: new Error("Permission denied") });
    await p.type("firefox");
    p.key({ key: "Enter" });
    await vi.waitFor(() => expect(p.root.querySelector(".pl-problem")?.textContent).toBe("Permission denied"));
  });

  it("searches DuckDuckGo when the chosen engine is unknown", async () => {
    const p = await open({ engine: "altavista" });
    await p.type("?tea");
    p.key({ key: "Enter" });
    await vi.waitFor(() => expect(p.did).toEqual(["url https://duckduckgo.com/?q=tea"]));
  });

  const folder: Hit = { path: "/home/me/Documents", name: "Documents", folder: "~", dir: true };
  const report: Hit = { path: "/home/me/report.pdf", name: "report.pdf", folder: "~", dir: false };

  it("opens a file, shows it in its folder on Ctrl+Enter, and opens a folder on Tab", async () => {
    const browsed: string[] = [];
    const p = await open({ files: true, port: { files: async () => [folder, report], browse: async (path) => (browsed.push(path), []) } });
    await p.type("docu");
    await vi.waitFor(() => expect(p.titles()).toContain("report.pdf"));
    const pick = (title: string) => {
      const row = [...p.root.querySelectorAll("li")].find((li) => li.querySelector(".pl-title")?.textContent === title);
      row!.dispatchEvent(new MouseEvent("mousemove"));
    };
    pick("report.pdf");
    expect(p.footer()).toContain("Ctrl↵ Show in folder");
    expect(p.footer()).not.toContain("Open folder");
    p.key({ key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(p.did).toEqual(["reveal /home/me/report.pdf"]));
    pick("Documents");
    expect(p.footer()).toContain("Tab Open folder");
    p.key({ key: "Tab" });
    expect(p.search.value).toBe("/home/me/Documents/");
    await vi.waitFor(() => expect(browsed).toEqual(["/home/me/Documents/"]));
  });

  it("follows the pointer, and runs what is clicked, its second action with Ctrl", async () => {
    const p = await open({ files: true, port: { files: async () => [report] } });
    await p.type("report");
    await vi.waitFor(() => expect(p.titles()[0]).toBe("report.pdf"));
    const rows = [...p.root.querySelectorAll("li")];
    rows[1]!.dispatchEvent(new MouseEvent("mousemove"));
    rows[1]!.dispatchEvent(new MouseEvent("mousemove"));
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
    rows[0]!.dispatchEvent(new MouseEvent("click", { ctrlKey: true }));
    await vi.waitFor(() => expect(p.did).toEqual(["reveal /home/me/report.pdf"]));
    rows[0]!.dispatchEvent(new MouseEvent("click"));
    await vi.waitFor(() => expect(p.did).toEqual(["reveal /home/me/report.pdf", "open /home/me/report.pdf"]));
  });

  it("keeps the selection when late results arrive, and drops those of an older query", async () => {
    const answers: ((hits: Hit[]) => void)[] = [];
    const p = await open({ files: true, port: { files: () => new Promise<Hit[]>((resolve) => answers.push(resolve)) } });
    await p.type("fi");
    p.key({ key: "ArrowDown" });
    const chosen = p.root.querySelector("[aria-selected=true] .pl-title")?.textContent;
    answers[0]!([{ ...report, name: "final.pdf" }]);
    await vi.waitFor(() => expect(p.titles()).toContain("final.pdf"));
    expect(p.root.querySelector("[aria-selected=true] .pl-title")?.textContent).toBe(chosen);
    await p.type("fir");
    await p.type("fire");
    answers[1]!([{ ...report, name: "old.pdf" }]);
    answers[2]!([]);
    await new Promise((r) => setTimeout(r));
    expect(p.titles()).not.toContain("old.pdf");
  });

  it("does nothing on Enter with nothing to run, or no second action", async () => {
    const p = await open();
    await p.type(">");
    expect(p.titles()).toEqual([]);
    p.key({ key: "Enter" });
    await p.type("firefox");
    p.key({ key: "Enter", ctrlKey: true });
    await new Promise((r) => setTimeout(r));
    expect(p.did).toEqual([]);
  });

  it("leaves other keys, and Esc with nothing to take back, to the window", async () => {
    const p = await open();
    await p.type("fi");
    for (const key of ["Escape", "a"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      p.search.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("gives an app with no name a question mark for a tile", async () => {
    const p = await open({ port: { apps: async () => [{ id: "x", name: " ", keywords: "mystery", detail: "" }] } });
    await p.type("mystery");
    expect(p.root.querySelector(".pl-initial")?.textContent).toBe("?");
  });

  it("is a tool on a shortcut, with no tab or glance", () => {
    expect(palette.slots).toEqual([]);
    expect(palette.commands?.map((c) => `${palette.id}.${c.id}`)).toEqual([SELF]);
  });
});

describe("the palette's providers, further", () => {
  it("shows remembered apps before anything is typed, and keeps the last list when listing fails", async () => {
    const remember: Recent = { ...forgetful, boost: (key) => (key === "app:firefox" ? 10 : 0) };
    let fail = false;
    const port: PalettePort = { ...idlePalette, apps: async () => (fail ? Promise.reject(new Error("gone")) : [{ id: "firefox", name: "Firefox", keywords: "", detail: "" }, { id: "files", name: "Files", keywords: "", detail: "" }]) };
    const apps = appsProvider(port, remember);
    await apps.refresh();
    fail = true;
    await apps.refresh();
    expect((apps.search({ mode: "all", text: "" }) as Item[]).map((i) => i.title)).toEqual(["Firefox"]);
    expect(apps.search({ mode: "web", text: "fi" })).toEqual([]);
  });

  it("lists the app's commands, its settings and quitting", async () => {
    const did: string[] = [];
    const host = {
      commands: (): CommandInfo[] => [{ id: "a.b", label: "Do it", description: "", icon: "", shortcut: null }],
      run: async (id: string) => void did.push(id),
      openSettings: async () => void did.push("settings"),
      quit: async () => void did.push("quit"),
    };
    const search = (text: string) => commandsProvider(host, SELF, forgetful).search({ mode: "all", text }) as Item[];
    const [command] = search("do it");
    expect(command).not.toHaveProperty("shortcut");
    await command!.primary.run();
    await search("settings")[0]!.primary.run();
    await search("quit")[0]!.primary.run();
    expect(did).toEqual(["a.b", "settings", "quit"]);
    expect(commandsProvider(host, SELF, forgetful).search({ mode: "web", text: "quit" })).toEqual([]);
  });

  it("opens a link as typed above a bare address, and only links when searching everything", async () => {
    const opened: string[] = [];
    const web = webProvider({ ...idlePalette, openUrl: async (url) => void opened.push(url) }, () => ({ label: "Qwant", url: "https://www.qwant.com/?q=" }));
    const [typed] = web.search({ mode: "all", text: "https://example.com/a" }) as Item[];
    const [bare] = web.search({ mode: "all", text: "example.com/a" }) as Item[];
    expect([typed?.title, typed?.score, bare?.score]).toEqual(["example.com/a", 9_000, 450]);
    await bare!.primary.run();
    expect(opened).toEqual(["https://example.com/a"]);
    expect((web.search({ mode: "web", text: "example.com" }) as Item[]).map((i) => i.kind)).toEqual(["web"]);
  });

  it("completes Windows paths with a backslash, and finds nothing when the system can't look", async () => {
    const win: Hit = { path: "C:\\Users\\me", name: "me", folder: "C:\\Users", dir: true };
    const port: PalettePort = { ...idlePalette, browse: async () => [win] };
    const [found] = await filesProvider(port, () => true).search({ mode: "path", text: "C:\\Users\\m" });
    expect(found).toMatchObject({ complete: "C:\\Users\\me\\", hits: [0] });
    const broken: PalettePort = { ...idlePalette, files: async () => Promise.reject(new Error("no index")), browse: async () => Promise.reject(new Error("gone")) };
    expect(await filesProvider(broken, () => true).search({ mode: "all", text: "notes" })).toEqual([]);
    expect(await filesProvider(broken, () => true).search({ mode: "path", text: "~/" })).toEqual([]);
  });

  it("marks no letters of a file found by a part of its path", async () => {
    const port: PalettePort = { ...idlePalette, files: async () => [{ path: "/a/b.txt", name: "b.txt", folder: "/a", dir: false }] };
    const [found] = await filesProvider(port, () => true).search({ mode: "all", text: "zz" });
    expect(found).toMatchObject({ kind: "file", hits: [] });
    expect(found).not.toHaveProperty("complete");
  });

  it("names things as each system does", () => {
    expect([trashTitle(true), trashTitle(false)]).toEqual(["Empty the Recycle Bin", "Empty the Trash"]);
  });

  it("needs nothing set up", () => {
    expect(palette.setup({ palette: idlePalette, clipboard: {} as ClipboardPort }, {} as never)).toEqual({});
  });
});

describe("what the palette remembers", () => {
  it("keeps the last two hundred", () => {
    let now = 0;
    const recent = recentIn(null, () => ++now);
    for (let i = 0; i < 205; i++) recent.note(`k${i}`);
    expect(recent.keys()).toHaveLength(200);
    expect(recent.keys()[0]).toBe("k204");
  });

  it("lives in the window's storage, when there is one to read", () => {
    localStorage.clear();
    localRecent().note("app:x");
    expect(localRecent().keys()).toEqual(["app:x"]);
    vi.stubGlobal("localStorage", undefined);
    expect(localRecent().keys()).toEqual([]);
    vi.unstubAllGlobals();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("denied"); } });
    try {
      expect(localRecent().keys()).toEqual([]);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  });
});
