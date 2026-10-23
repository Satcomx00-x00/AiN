// @vitest-environment happy-dom
/**
 * The settings page, section by section, run against the fake system of the integration harness:
 * what each control saves, what the page says when the system refuses, and how it moves between
 * sections, plugin pages and the Updates card.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sdk } from "../../../sdk";
import type { SettingsPorts } from "./ports";
import type { Report, UpdaterPort } from "../../updater";
import { advance, environment, pick, press, restore, system, type System } from "../../../integration/harness";

const dialog = vi.hoisted(() => ({ open: vi.fn<(options: Record<string, unknown>) => Promise<string | string[] | null>>() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

afterEach(() => {
  restore();
  dialog.open.mockReset();
});

/** Loads a fresh settings page on `sys`, at `at`, with `extra` ports in place of the harness's. */
async function load(sys: System, at = "", extra: Partial<SettingsPorts> = {}) {
  history.replaceState(null, "", at ? `/#${at}` : "/");
  vi.resetModules();
  const ports = await import("./ports");
  ports.usePorts({
    store: sys.store,
    popup: sys.popup,
    folder: sys.folder,
    importer: sys.importer,
    community: sys.community,
    secrets: sys.secrets,
    services: sys.services,
    inApp: false,
    ...extra,
  });
  await import("./main");
  await advance(0);
  const page = document.querySelector<HTMLElement>(".app")!;
  const nav = (label: string) => [...page.querySelectorAll<HTMLButtonElement>("nav button")].find((b) => b.textContent?.trim() === label)!;
  return {
    page,
    open: async (label: string) => {
      nav(label).click();
      await advance(0);
    },
    field: (label: string) => [...page.querySelectorAll<HTMLElement>(".field")].find((f) => f.querySelector(".field-label")?.textContent?.trim() === label)!,
    card: (title: string) => [...page.querySelectorAll<HTMLElement>(".card")].find((c) => c.querySelector("h2")?.textContent === title)!,
    status: () => page.querySelector<HTMLElement>(".status")!,
    heading: () => page.querySelector("h1")?.textContent,
    saved: () => advance(400),
  };
}

const slide = (row: HTMLElement, value: number) => {
  const input = row.querySelector<HTMLInputElement>("input[type=range]")!;
  input.value = String(value);
  input.dispatchEvent(new Event("input"));
};
const typeHex = (row: HTMLElement, hex: string) => {
  const input = row.querySelector<HTMLInputElement>(".cp-hex")!;
  input.value = hex;
  input.dispatchEvent(new Event("input"));
};
const buttonIn = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
const turnOn = async (page: Awaited<ReturnType<typeof load>>, file: string) => {
  [...page.page.querySelectorAll<HTMLElement>(".card")].find((c) => c.querySelector(".mono")?.textContent === file)!.querySelector<HTMLElement>("[role=switch]")!.click();
  await page.saved();
};

describe("Saving", () => {
  it("says when the settings couldn't be saved", async () => {
    environment();
    const sys = system();
    const page = await load(sys);
    vi.spyOn(sys.store, "save").mockRejectedValue(new Error("disk full"));
    slide(page.field("Open delay"), 300);
    expect(page.status().textContent).toBe("Saving…");
    await page.saved();
    expect(page.status().dataset.state).toBe("error");
    expect(page.status().textContent).toBe("Not saved: Error: disk full");
  });

  it("keeps what is being edited when other settings arrive meanwhile, and saves it", async () => {
    environment();
    const sys = system();
    const page = await load(sys);
    slide(page.field("Open delay"), 300);
    await sys.save((s) => ({ ...s, general: { ...s.general, closeDelay: 900 } }));
    await advance(0);
    expect(page.field("Open delay").querySelector("output")?.textContent).toBe("300 ms");
    await page.saved();
    expect((await sys.settings()).general.openDelay).toBe(300);
    expect(page.status().textContent).toBe("Saved");
  });
});

describe("Settings → General", () => {
  const launch = (page: Awaited<ReturnType<typeof load>>) => page.field("Launch at login").querySelector<HTMLButtonElement>("[role=switch]")!;

  it("turns launching at login on", async () => {
    environment();
    const sys = system();
    const page = await load(sys);
    expect(launch(page).getAttribute("aria-checked")).toBe("false");
    launch(page).click();
    await advance(0);
    expect(await sys.store.autostart()).toBe(true);
    expect(launch(page).getAttribute("aria-checked")).toBe("true");
  });

  it("flips the switch back, and says why, when the system refuses", async () => {
    environment();
    const sys = system();
    vi.spyOn(sys.store, "setAutostart").mockRejectedValue(new Error("denied"));
    const page = await load(sys);
    launch(page).click();
    await advance(0);
    expect(launch(page).getAttribute("aria-checked")).toBe("false");
    expect(page.status().textContent).toBe("Launch at login: Error: denied");
  });

  it("shows the switch shown off when the system can't tell", async () => {
    environment();
    const sys = system();
    vi.spyOn(sys.store, "autostart").mockRejectedValue(new Error("unsupported"));
    const page = await load(sys);
    expect(launch(page).disabled).toBe(true);
  });

  it("quits the app, and says when it can't", async () => {
    environment();
    const sys = system();
    const quit = vi.spyOn(sys.store, "quit").mockResolvedValueOnce().mockRejectedValueOnce(new Error("busy"));
    const page = await load(sys);
    press(page.field("Quit AiN"), "Quit");
    await advance(0);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(page.status().textContent).toBe("Saved");
    press(page.field("Quit AiN"), "Quit");
    await advance(0);
    expect(page.status().textContent).toBe("Couldn't quit: Error: busy");
  });

  it("saves how long the island waits to open and to close", async () => {
    environment();
    const sys = system();
    const page = await load(sys);
    slide(page.field("Open delay"), 400);
    slide(page.field("Close delay"), 600);
    await page.saved();
    const { general } = await sys.settings();
    expect([general.openDelay, general.closeDelay]).toEqual([400, 600]);
  });
});

describe("Settings → Appearance", () => {
  it("saves the pill's colors, and the page takes the accent too", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "appearance");
    typeHex(page.field("Pill color"), "#202020");
    typeHex(page.field("Accent color"), "#ff375f");
    await page.saved();
    const { general } = await sys.settings();
    expect([general.pillColor, general.accentColor]).toEqual(["#202020", "#ff375f"]);
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#ff375f");
  });

  it("saves the pill's width and corner curve", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "appearance");
    slide(page.field("Pill width"), 300);
    slide(page.field("Corner curve"), 40);
    await page.saved();
    const { general } = await sys.settings();
    expect([general.pillWidth, general.pillCurve]).toEqual([300, 40]);
  });

  it("applies a theme with its pill and accent colors, and names it", async () => {
    environment();
    const sys = system();
    const { THEMES } = await import("../../themes");
    const theme = THEMES[1]!;
    const page = await load(sys, "appearance");
    page.field("Theme").querySelector<HTMLElement>(`[title="${theme.name}"]`)!.click();
    await page.saved();
    const { general } = await sys.settings();
    expect([general.theme, general.pillColor, general.accentColor]).toEqual([theme.id, theme.bg, theme.accent]);
    expect(page.field("Theme").querySelector(".field-hint")?.textContent).toBe(theme.name);
    expect(page.field("Theme").querySelector(`[title="${theme.name}"]`)?.getAttribute("aria-checked")).toBe("true");
  });

  it("saves how long the cursor must rest for the Hidden style", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "appearance");
    pick(page.field("Pill style"), "Hidden");
    await advance(0);
    slide(page.field("Show after"), 1200);
    await page.saved();
    expect((await sys.settings()).general.revealDelay).toBe(1200);
  });

  it("plays the startup animation shown on the island, and can choose none", async () => {
    environment();
    const sys = system();
    const played: string[] = [];
    await sys.store.onPlayGreeting((id) => played.push(id));
    const page = await load(sys, "appearance");
    const animation = page.field("Startup animation");
    pick(animation, "Boing");
    animation.querySelector<HTMLButtonElement>("[aria-label=Play]")!.click();
    await page.saved();
    expect(played).toEqual(["boing"]);
    expect((await sys.settings()).general.greeting).toBe("boing");

    pick(animation, "None");
    expect(animation.querySelector<HTMLButtonElement>("[aria-label=Play]")?.disabled).toBe(true);
    await page.saved();
    expect((await sys.settings()).general.greeting).toBe("none");
  });

  it("says when the island can't play it", async () => {
    environment();
    const sys = system();
    vi.spyOn(sys.store, "playGreeting").mockRejectedValue(new Error("island closed"));
    const page = await load(sys, "appearance");
    page.field("Startup animation").querySelector<HTMLButtonElement>("[aria-label=Play]")!.click();
    await advance(0);
    expect(page.status().textContent).toBe("Couldn't play it: Error: island closed");
  });

  it("shows the default animation when the chosen one's plugin is gone", async () => {
    environment();
    const sys = system();
    await sys.save((s) => ({ ...s, general: { ...s.general, greeting: "fireworks" } }));
    const page = await load(sys, "appearance");
    expect(page.field("Startup animation").querySelector(".ui-select-trigger")?.textContent).toBe("Hello");
  });

  it("offers a plugin's animation and style only while its file is on", async () => {
    environment();
    const sys = system();
    sys.addFile("wave.js", (island: Sdk) => island.defineGreeting({ id: "wave", label: "Wave", play: async () => {} }));
    sys.addFile("neon.js", (island: Sdk) => island.defineStyle({ id: "neon", label: "Neon", mount: () => ({ draw() {} }) }));
    await sys.save((s) => ({ ...s, extensions: ["neon.js", "wave.js"] }));
    const page = await load(sys, "appearance");
    await advance(0);
    await page.open("Appearance");
    const options = (label: string) => [...page.field(label).querySelectorAll(".ui-select-option .ui-select-label")].map((l) => l.textContent);
    expect(options("Startup animation")).toContain("WavePlugin");
    expect(options("Pill style")).toContain("NeonPlugin");

    await sys.save((s) => ({ ...s, extensions: [] }));
    await advance(0);
    expect(options("Startup animation")).not.toContain("WavePlugin");
    expect(options("Pill style")).not.toContain("NeonPlugin");
  });
});

describe("Settings → Layout", () => {
  const list = (page: Awaited<ReturnType<typeof load>>, title: string) => page.card(title);
  const names = (card: HTMLElement) => [...card.querySelectorAll(".slot-name")].map((n) => n.textContent);

  it("moves, removes and adds widgets on each side of the pill and in the tabs", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "layout");
    expect(page.heading()).toBe("Layout");
    expect(names(list(page, "Left of the pill"))).toEqual(["Clock"]);

    list(page, "Left of the pill").querySelector<HTMLButtonElement>("[aria-label='Remove Clock']")!.click();
    await page.saved();
    expect((await sys.settings()).layout.glance.left).toEqual([]);
    expect(list(page, "Left of the pill").textContent).toContain("Nothing here yet.");

    const add = list(page, "Right of the pill").querySelector<HTMLSelectElement>(".slot-add")!;
    add.value = "clock";
    add.dispatchEvent(new Event("change"));
    await page.saved();
    expect((await sys.settings()).layout.glance.right.at(-1)).toBe("clock");

    list(page, "Tabs").querySelector<HTMLButtonElement>("[aria-label='Move Now playing down']")!.click();
    await page.saved();
    expect((await sys.settings()).layout.tabs.slice(0, 2)).toEqual(["clock", "media"]);
  });

  it("restores the default layout", async () => {
    environment();
    const sys = system();
    const { layout } = await import("../../../features/layout");
    await sys.save((s) => ({ ...s, layout: { glance: { left: [], right: [] }, tabs: ["clock"] } }));
    const page = await load(sys, "layout");
    press(page.page, "Restore default layout");
    await page.saved();
    expect((await sys.settings()).layout).toEqual(layout);
  });
});

describe("Settings → Shortcuts", () => {
  const DICTATE = "Dictate · Dictation";
  const keysOf = (row: HTMLElement) => row.querySelector(".keys")?.textContent;
  const key = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, ...init }));

  it("records a new shortcut once a key joins the modifiers, then resets it", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "shortcuts");
    expect(keysOf(page.field(DICTATE))).toBe("CtrlAltD");
    press(page.field(DICTATE), "Change");
    expect(buttonIn(page.field(DICTATE), "Press keys…")?.classList).toContain("recording");
    expect(keysOf(page.field(DICTATE))).toBe("Esc to cancel, Backspace to turn off");
    key({ code: "ShiftLeft", key: "Shift", shiftKey: true });
    expect(keysOf(page.field(DICTATE))).toBe("Esc to cancel, Backspace to turn off");
    key({ code: "KeyK", key: "k", ctrlKey: true, shiftKey: true });
    await page.saved();
    expect((await sys.settings()).shortcuts["dictation.toggle"]).toBe("Ctrl+Shift+KeyK");
    expect(keysOf(page.field(DICTATE))).toBe("CtrlShiftK");

    // Recording stopped: other keys change nothing.
    key({ code: "KeyJ", key: "j", ctrlKey: true });
    press(page.field(DICTATE), "Reset");
    await page.saved();
    expect((await sys.settings()).shortcuts).toEqual({});
    expect(keysOf(page.field(DICTATE))).toBe("CtrlAltD");
    expect(buttonIn(page.field(DICTATE), "Reset")).toBeUndefined();
  });

  it("cancels recording on Esc", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "shortcuts");
    press(page.field(DICTATE), "Change");
    key({ code: "Escape", key: "Escape" });
    await page.saved();
    expect(keysOf(page.field(DICTATE))).toBe("CtrlAltD");
    expect((await sys.settings()).shortcuts).toEqual({});
  });

  it("turns a shortcut off with Backspace or Delete", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "shortcuts");
    press(page.field(DICTATE), "Change");
    key({ code: "Backspace", key: "Backspace" });
    await page.saved();
    expect((await sys.settings()).shortcuts).toEqual({ "dictation.toggle": null });
    expect(keysOf(page.field(DICTATE))).toBe("Off");

    press(page.field("Read aloud · Read aloud"), "Change");
    key({ code: "Delete", key: "Delete" });
    await page.saved();
    expect((await sys.settings()).shortcuts["tts.read"]).toBeNull();
  });

  it("says which shortcuts the system wouldn't register, as soon as it knows", async () => {
    environment();
    const sys = system();
    let report: (failures: Record<string, string>) => void = () => {};
    const popup = { ...sys.popup, watchFailures: async (onChange: typeof report) => ((report = onChange), onChange({}), () => {}) };
    const page = await load(sys, "shortcuts", { popup });
    expect(page.field(DICTATE).classList).not.toContain("failed");
    report({ "dictation.toggle": "already used by another app" });
    expect(page.field(DICTATE).classList).toContain("failed");
    expect(page.field(DICTATE).querySelector(".field-hint")?.textContent).toBe(
      "Types what you say where the cursor is. — already used by another app: pick another shortcut.",
    );
    // Elsewhere in Settings, nothing is redrawn.
    await page.open("General");
    report({});
    expect(page.heading()).toBe("General");
  });

  it("tries a shortcut's command in the app, and only there", async () => {
    environment();
    const sys = system();
    const open = vi.spyOn(sys.popup, "open").mockResolvedValueOnce().mockRejectedValueOnce(new Error("no popup"));
    const preview = await load(sys, "shortcuts");
    expect(buttonIn(preview.field(DICTATE), "Try it")?.disabled).toBe(true);

    environment();
    const page = await load(sys, "shortcuts", { inApp: true });
    press(page.field(DICTATE), "Try it");
    press(page.field("Clipboard history · Clipboard"), "Try it");
    await advance(0);
    expect(open.mock.calls).toEqual([
      ["dictation.toggle", "action"],
      ["clipboard.history", "popup"],
    ]);
    expect(page.status().textContent).toBe("Saved");
  });
});

describe("Settings → Widgets", () => {
  it("picks a folder with the system dialog in the app, starting from the current one", async () => {
    environment();
    const sys = system();
    dialog.open.mockResolvedValueOnce("D:\\models").mockResolvedValueOnce(null);
    const page = await load(sys, "widgets", { inApp: true });
    const folder = () => page.card("Dictation").querySelector<HTMLElement>(".path")!;
    press(folder(), "Browse…");
    await page.saved();
    expect(dialog.open).toHaveBeenLastCalledWith({ directory: true, multiple: false });
    expect((await sys.settings()).options.dictation?.modelDir).toBe("D:\\models");

    press(folder(), "Browse…");
    await page.saved();
    expect(dialog.open).toHaveBeenLastCalledWith({ directory: true, multiple: false, defaultPath: "D:\\models" });
    expect(folder().querySelector("input")?.value).toBe("D:\\models");
  });

  it("has no folder dialog outside the app", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "widgets");
    press(page.card("Dictation").querySelector(".path")!, "Browse…");
    await page.saved();
    expect(dialog.open).not.toHaveBeenCalled();
    expect((await sys.settings()).options.dictation).toBeUndefined();
  });

  it("saves what a plugin's own settings panel sets", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "widgets", { inApp: true });
    const models = page.card("Dictation").querySelector<HTMLElement>(".plugin-panel [aria-label='Speech model']")!.parentElement!;
    pick(models, "Whisper small");
    await page.saved();
    expect((await sys.settings()).options.dictation).toEqual({ model: "whisper-small" });
  });

  it("says when a plugin has no options", async () => {
    environment();
    const sys = system();
    sys.addFile("bare.js", (island: Sdk) => island.definePlugin({ id: "bare", label: "Bare", description: "", icon: "", slots: ["tab"], setup: () => ({ panel() {} }) }));
    await sys.save((s) => ({ ...s, extensions: ["bare.js"] }));
    const page = await load(sys, "widgets");
    await advance(0);
    await page.open("Widgets");
    expect(page.card("Bare").querySelector(".no-options")?.textContent).toBe("No options.");
    expect(page.card("Bare").querySelector<HTMLElement>(".needs-setup")?.hidden).toBe(true);
  });

  it("shows no setup badge when the credential store can't say what's missing", async () => {
    environment();
    const sys = system();
    sys.addFile("weather.js", (island: Sdk) =>
      island.definePlugin({
        id: "weather",
        label: "Weather",
        description: "",
        icon: "",
        slots: ["glance"],
        options: { apiKey: island.options.secret("API key", { required: true }) },
        setup: () => ({ glance: () => null }),
      }),
    );
    await sys.save((s) => ({ ...s, extensions: ["weather.js"] }));
    vi.spyOn(sys.secrets, "saved").mockRejectedValue(new Error("locked"));
    const page = await load(sys, "widgets");
    await advance(0);
    await page.open("Widgets");
    await advance(0);
    expect(page.card("Weather").querySelector<HTMLElement>(".needs-setup")?.hidden).toBe(true);
    expect(page.card("Weather").querySelector(".field-error")?.textContent).toBe("Couldn't read the credential store: locked");
  });
});

describe("Settings → Plugins", () => {
  it("says the folder isn't available when it can't be read", async () => {
    environment();
    const sys = system();
    sys.addFile("a.js", () => null);
    vi.spyOn(sys.folder, "list").mockRejectedValue(new Error("no folder"));
    const page = await load(sys, "plugins");
    expect(page.page.querySelector(".folder-bar .mono")?.textContent).toBe("Not available in the preview");
    expect(page.page.textContent).toContain("No plugins yet.");
  });

  it("opens the plugins folder in the app, then shows what was put there", async () => {
    environment();
    const sys = system();
    const openDir = vi.spyOn(sys.folder, "openDir").mockImplementation(async () => sys.addFile("dropped.js", () => null));
    const preview = await load(sys, "plugins");
    expect(buttonIn(preview.page.querySelector(".folder-bar")!, "Open")?.disabled).toBe(true);

    environment();
    const page = await load(sys, "plugins", { inApp: true });
    press(page.page.querySelector(".folder-bar")!, "Open");
    await advance(0);
    expect(openDir).toHaveBeenCalled();
    expect(page.card("Dropped")?.querySelector(".mono")?.textContent).toBe("dropped.js");

    openDir.mockRejectedValueOnce(new Error("no file manager"));
    press(page.page.querySelector(".folder-bar")!, "Open");
    await advance(0);
    expect(page.status().textContent).toBe("Saved");
  });

  it("loads a file turned on after another that couldn't be used", async () => {
    environment();
    const sys = system();
    sys.addFile("broken.js", () => {
      throw new Error("syntax error");
    });
    sys.addFile("fine.js", (island: Sdk) => island.definePlugin({ id: "fine", label: "Fine", description: "Works.", icon: "", slots: ["tab"], setup: () => ({ panel() {} }) }));
    const page = await load(sys, "plugins");
    await turnOn(page, "broken.js");
    const broken = page.card("Broken");
    expect(broken.classList).toContain("failed");
    expect(broken.textContent).toContain("Can't be used: failed to load: Error: syntax error");
    await turnOn(page, "fine.js");
    expect(page.card("Fine").textContent).toContain("Works.");
    expect((await sys.settings()).layout.tabs).toContain("fine");
  });

  it("says which services a plugin uses, and marks animation files as such", async () => {
    environment();
    const sys = system();
    sys.addFile("cpu.js", (island: Sdk) =>
      island.definePlugin({ id: "cpu", label: "CPU", description: "Load.", icon: "", slots: ["glance"], needs: ["stats"], setup: () => ({ glance: () => null }) }),
    );
    sys.addFile("wave.js", (island: Sdk) => island.defineGreeting({ id: "wave", label: "Wave", play: async () => {} }));
    await sys.save((s) => ({ ...s, extensions: ["cpu.js", "wave.js"] }));
    const page = await load(sys, "plugins");
    await advance(0);
    expect(page.card("CPU").textContent).toContain("Load. Uses: stats.");
    expect(page.card("Wave").textContent).toContain("Startup animation, chosen in Appearance.");
    expect(page.card("Wave").querySelector(".ico")?.innerHTML).toContain("M8 2.5");
  });

  it("names a file by itself when its name has no words", async () => {
    environment();
    const sys = system();
    sys.addFile("_.js", () => null);
    const page = await load(sys, "plugins");
    expect(page.card("_.js")?.querySelector(".mono")?.textContent).toBe("_.js");
  });

  it("ignores the options of a store listing that declares them wrong", async () => {
    environment();
    const sys = system();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sys.addOffer({ id: "odd", name: "Odd", description: "Odd options.", repo: "https://github.com/o/r", options: "not fields" as never }, () => null as never);
    sys.addFile("odd/index.js", () => null);
    const page = await load(sys, "plugins");
    const card = [...page.page.querySelectorAll<HTMLElement>(".card:not(.store-card)")].find((c) => c.textContent?.includes("odd/index.js"))!;
    expect(card.querySelector("h2")?.textContent).toBe("Odd");
    expect(card.querySelectorAll(".field")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(`[settings] store plugin "odd": options must be an object of fields`);
  });

  it("says why the store couldn't be read, whatever the failure", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "plugins", { community: { ...sys.community, catalog: async () => Promise.reject("offline") } });
    expect(page.page.querySelector(".note.failed")?.textContent).toBe("Couldn't read the store: offline");
  });

  it("reads the store once while it's slow, however often the page redraws", async () => {
    environment();
    const sys = system();
    let answer: () => void = () => {};
    const catalog = vi.fn(() => new Promise<{ url: string; plugins: [] }>((r) => (answer = () => r({ url: "", plugins: [] }))));
    const page = await load(sys, "plugins", { community: { ...sys.community, catalog } });
    expect(page.page.textContent).toContain("Reading the store…");
    await page.open("Plugins");
    expect(catalog).toHaveBeenCalledTimes(1);
    answer();
    await advance(0);
    expect(page.page.textContent).toContain("The store has no plugins yet.");
  });

  it("carries on when a repository can't be opened", async () => {
    environment();
    const sys = system();
    sys.addOffer({ id: "orbit", name: "Orbit", description: "", repo: "https://github.com/o/r" }, () => null as never);
    const openRepo = vi.fn(async () => Promise.reject(new Error("no browser")));
    const page = await load(sys, "plugins", { community: { ...sys.community, openRepo } });
    press(page.page.querySelector(".store-card")!, "Repository");
    await advance(0);
    expect(openRepo).toHaveBeenCalledWith("orbit");
    expect(page.status().textContent).toBe("Saved");
  });
});

describe("Settings → About", () => {
  /** An updater whose reports the test pushes; its actions are spies. */
  function updater(first: Report | null = null) {
    let push: (r: Report) => void = () => {};
    const port = {
      status: vi.fn(async () => first ?? new Promise<Report>(() => {})),
      check: vi.fn<UpdaterPort["check"]>(),
      install: vi.fn<UpdaterPort["install"]>(),
      openReleases: vi.fn<UpdaterPort["openReleases"]>(),
      watch: vi.fn(async (on: (r: Report) => void) => ((push = on), () => {})),
    };
    return { port, push: async (r: Report) => (push(r), advance(0)) };
  }
  const report = (state: Report["state"], releases = "https://github.com/o/r/releases"): Report => ({ current: "0.7.0", state, releases });
  const card = () => document.getElementById("card-updates")!;

  it("says it's loading until the updater first reports, even if it can't", async () => {
    environment();
    const { port } = updater();
    port.status.mockRejectedValue(new Error("no updater"));
    const page = await load(system(), "about", { updater: port });
    expect(page.heading()).toBe("About");
    expect(card().textContent).toBe("Loading…");
  });

  it("checks for updates, and says when checking failed", async () => {
    environment();
    const { port, push } = updater(report({ kind: "idle" }));
    port.check.mockRejectedValue(new Error("offline"));
    const page = await load(system(), "about", { updater: port });
    expect(card().querySelector("h2")?.textContent).toBe("AiN 0.7.0");
    expect(card().textContent).toContain("Not checked yet.");
    press(card(), "Check now");
    await advance(0);
    expect(port.check).toHaveBeenCalled();
    expect(page.status().textContent).toBe("Update: Error: offline");

    await push(report({ kind: "checking" }));
    expect(buttonIn(card(), "Checking…")?.disabled).toBe(true);
    expect(card().querySelector(".update-badge")?.textContent).toBe("Checking");
  });

  it("shows what's new in an update, and installs it", async () => {
    environment();
    const { port, push } = updater(report({ kind: "idle" }));
    port.install.mockRejectedValue(new Error("signature mismatch"));
    const page = await load(system(), "about", { updater: port });
    await push(report({ kind: "available", version: "0.8.0", notes: "### Features\n- Weather\n\n- Faster" }));
    expect(card().dataset.tone).toBe("accent");
    expect(card().querySelector(".update-notes-label")?.textContent).toBe("What's new in 0.8.0");
    const body = card().querySelector(".update-notes-body")!;
    expect([...body.children].map((c) => `${c.tagName}:${c.textContent}`)).toEqual(["H3:Features", "P:• Weather", "DIV:", "P:• Faster"]);
    press(card(), "Install and restart");
    await advance(0);
    expect(port.install).toHaveBeenCalled();
    expect(page.status().textContent).toBe("Update: Error: signature mismatch");
  });

  it("shows the download's progress, redrawing only its card", async () => {
    environment();
    const { port, push } = updater(report({ kind: "available", version: "0.8.0", notes: null }));
    const page = await load(system(), "about", { updater: port });
    expect(card().querySelector(".update-notes")).toBeNull();
    const reset = buttonIn(page.page, "Reset")!;
    await push(report({ kind: "downloading", version: "0.8.0", received: 512, total: 1024 }));
    expect(card().querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("50");
    expect(buttonIn(card(), "Installing…")?.disabled).toBe(true);
    expect(buttonIn(page.page, "Reset")).toBe(reset);
  });

  it("points to the releases page when updates are off, or says nothing of it without one", async () => {
    environment();
    const { port, push } = updater(report({ kind: "disabled", reason: "Updates are off in this build." }));
    port.openReleases.mockRejectedValue(new Error("no browser"));
    const page = await load(system(), "about", { updater: port });
    expect(card().querySelector(".update-foot")?.textContent).toContain("Download new versions by hand from the releases page.");
    expect(buttonIn(card(), "Check now")?.disabled).toBe(true);
    press(card(), "All releases ↗");
    await advance(0);
    expect(port.openReleases).toHaveBeenCalled();
    expect(page.status().textContent).toBe("Update: Error: no browser");

    await push(report({ kind: "upToDate" }, ""));
    expect(buttonIn(card(), "All releases ↗")).toBeUndefined();
    expect(card().querySelector(".update-foot")?.textContent).toContain("Checked at launch, then every 6 hours.");
  });

  it("keeps a plugin's page open while the updater reports", async () => {
    environment();
    const sys = system();
    let navigate: (target: string) => void = () => {};
    vi.spyOn(sys.store, "onNavigate").mockImplementation(async (on) => ((navigate = on), () => {}));
    const { port, push } = updater(report({ kind: "idle" }));
    const page = await load(sys, "about", { updater: port });
    navigate("page:ghost");
    await advance(0);
    await push(report({ kind: "checking" }));
    expect(page.page.querySelector(".lead")?.textContent).toBe("This plugin isn't turned on: see Plugins.");
    expect(card()).toBeNull();
  });

  it("resets every setting only on a second click", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "about");
    const reset = buttonIn(page.field("Reset all settings"), "Reset")!;
    reset.click();
    expect(reset.textContent).toBe("Click again to confirm");
    expect(reset.classList).toContain("danger");
    await page.saved();
    expect((await sys.settings()).options).toEqual({ clock: { format: "24" } });
    reset.click();
    await page.saved();
    expect((await sys.settings()).options).toEqual({});
  });
});

describe("A plugin's page", () => {
  /** A plugin whose page shows its option, and links to another note. */
  const notes = (island: Sdk) =>
    island.definePlugin({
      id: "notes",
      label: "Notes",
      description: "Notes.",
      icon: "",
      slots: ["tab"],
      options: { last: island.options.text("Last note", "first") },
      page(root, _services, host) {
        root.append(
          island.dom.h("p", { class: "last" }, String(host.options().last)),
          island.dom.button("Next", () => host.openPage({ id: String(Number(host.params.id ?? 0) + 1) })),
        );
      },
      setup: () => ({ panel() {} }),
    });

  it("reads its options, and opens another of its pages", async () => {
    environment();
    const sys = system();
    sys.addFile("notes.js", notes);
    await sys.save((s) => ({ ...s, extensions: ["notes.js"] }));
    const page = await load(sys, "page:notes?id=1", { inApp: true });
    await advance(0);
    expect(page.page.querySelector(".last")?.textContent).toBe("first");
    press(page.page, "Next");
    await advance(0);
    expect(location.hash).toBe("#page:notes?id=2");
    expect(page.page.querySelectorAll(".plugin-page")).toHaveLength(1);
  });

  it("gives a plugin without options none, in its panel and on its page", async () => {
    environment();
    const sys = system();
    sys.addFile("sketch.js", (island: Sdk) =>
      island.definePlugin({
        id: "sketch",
        label: "Sketch",
        description: "",
        icon: "",
        slots: ["tab"],
        settingsPanel(root, _services, host) {
          root.append(island.dom.h("p", { class: "seen" }, JSON.stringify(host.options())));
        },
        page(root, _services, host) {
          root.append(island.dom.h("p", { class: "seen" }, JSON.stringify(host.options())));
        },
        setup: () => ({ panel() {} }),
      }),
    );
    await sys.save((s) => ({ ...s, extensions: ["sketch.js"] }));
    const page = await load(sys, "widgets", { inApp: true });
    await advance(0);
    await page.open("Widgets");
    expect(page.card("Sketch").querySelector(".seen")?.textContent).toBe("{}");
    environment();
    const view = await load(sys, "page:sketch", { inApp: true });
    await advance(0);
    expect(view.page.querySelector(".plugin-page .seen")?.textContent).toBe("{}");
  });

  it("says when a plugin has no page", async () => {
    environment();
    const page = await load(system(), "page:clock", { inApp: true });
    await advance(0);
    expect(page.heading()).toBe("Clock");
    expect(page.page.querySelector(".lead")?.textContent).toBe("Clock has no page.");
  });

  it("is only drawn in the app", async () => {
    environment();
    const sys = system();
    sys.addFile("notes.js", notes);
    await sys.save((s) => ({ ...s, extensions: ["notes.js"] }));
    const page = await load(sys, "page:notes");
    await advance(0);
    expect(page.page.querySelector(".lead")?.textContent).toBe("This page is available in the app.");
    expect(page.page.querySelector(".plugin-page")).toBeNull();
  });

  it("says it's loading while the plugins folder is being read", async () => {
    environment();
    const sys = system();
    sys.addFile("notes.js", notes);
    await sys.save((s) => ({ ...s, extensions: ["notes.js"] }));
    let listed: () => void = () => {};
    const list = sys.folder.list;
    const folder = { ...sys.folder, list: () => new Promise<Awaited<ReturnType<typeof list>>>((r) => (listed = () => void list().then(r))) };
    const page = await load(sys, "page:notes", { folder, inApp: true });
    expect(page.page.querySelector(".lead")?.textContent).toBe("Loading…");
    listed();
    await advance(0);
    expect(page.page.querySelector(".last")?.textContent).toBe("first");
  });

  it("leaves once on Back, however often it's clicked", async () => {
    environment();
    const sys = system();
    const page = await load(sys, "page:ghost");
    const back = buttonIn(page.page, "‹ Widgets")!;
    back.click();
    await advance(0);
    expect(page.heading()).toBe("Widgets");
    await page.open("General");
    back.click();
    await advance(0);
    expect(page.heading()).toBe("General");
  });
});

describe("Opening Settings at a place", () => {
  it("goes where something else asks: a plugin's page or a section, and ignores the rest", async () => {
    environment();
    const sys = system();
    let navigate: (target: string) => void = () => {};
    vi.spyOn(sys.store, "onNavigate").mockImplementation(async (on) => ((navigate = on), () => {}));
    const page = await load(sys);
    navigate("page:ghost");
    await advance(0);
    expect(location.hash).toBe("#page:ghost");

    navigate("nowhere");
    await advance(0);
    expect(location.hash).toBe("#page:ghost");

    navigate("widgets:ghost");
    await advance(0);
    expect(page.heading()).toBe("Widgets");
    expect(page.page.querySelector(".highlight")).toBeNull();
  });
});
