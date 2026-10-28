// @vitest-environment happy-dom
/**
 * The settings page and the island side by side on one settings store, as in the app: what is
 * changed on the page is saved, and the island follows.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Sdk } from "../sdk";
import { advance, environment, pick, press, restore, startIsland, startSettings, system } from "./harness";

afterEach(restore);


/** The toasts shown now, as "[code] title: message". */
const toasts = () =>
  [...document.querySelectorAll<HTMLElement>(".toast")].map(
    (t) => `[${t.querySelector(".toast-code")?.textContent ?? ""}] ${t.querySelector(".toast-title")?.textContent}: ${t.querySelector(".toast-message")?.textContent ?? ""}`,
  );

describe("Settings → Appearance", () => {
  it("makes the pill large, and the island grows", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    const page = await startSettings(sys, "appearance");
    press(page.field("Size")!, "Large");
    await page.saved();
    expect((await sys.settings()).general.pillSize).toBe("large");
    expect(island.size()).toEqual({ width: "520px", height: "44px" });
  });

  it("lists every built-in style with a line about it, and picking one restyles the island", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    const page = await startSettings(sys, "appearance");
    const field = page.field("Pill style")!;
    const labels = [...field.querySelectorAll(".ui-select-option .ui-select-label")].map((l) => l.childNodes[0]?.textContent);
    expect(labels).toEqual(["Pill", "Solo", "Stub", "Sliver", "Hidden"]);
    expect(field.querySelectorAll(".ui-select-option .ui-select-detail")).toHaveLength(5);
    pick(field, "Stub");
    await page.saved();
    expect(island.el.dataset.style).toBe("stub");
    expect(island.size()).toEqual({ width: "56px", height: "14px" });
  });

  it("asks how long to wait only for the Hidden style, and the island starts hiding", async () => {
    environment();
    const sys = system();
    await startIsland(sys);
    const page = await startSettings(sys, "appearance");
    expect(page.field("Show after")).toBeNull();
    pick(page.field("Pill style")!, "Hidden");
    await page.saved();
    expect(page.field("Show after")).not.toBeNull();
    expect(sys.recorded.rules.at(-1)).toEqual([500, 760]);
  });

  it("shows the options of a plugin's style under the picker, and saves them for it", async () => {
    environment();
    const sys = system();
    sys.addFile("neon.js", (island) =>
      island.defineStyle({
        id: "neon",
        label: "Neon",
        description: "A glowing line.",
        options: { glow: island.options.toggle("Glow", true) },
        mount: () => ({ draw() {} }),
      }),
    );
    await sys.save((s) => ({ ...s, extensions: ["neon.js"], general: { ...s.general, style: "neon" } }));
    const island = await startIsland(sys);
    const page = await startSettings(sys, "appearance");
    await advance(0);
    await page.open("Appearance");
    const option = [...page.page.querySelectorAll(".ui-select-option")].find((o) => o.textContent?.includes("Neon"));
    expect(option?.querySelector(".ui-select-badge")?.textContent).toBe("Plugin");
    const glow = page.field("Glow")?.querySelector<HTMLElement>("[role=switch]");
    expect(glow?.getAttribute("aria-checked")).toBe("true");
    glow?.click();
    await page.saved();
    expect((await sys.settings()).options.neon).toEqual({ glow: false });
    expect(island.el.dataset.style).toBe("neon");
  });
});

describe("Settings → Notifications", () => {
  it("sends a test notification that the island shows, and keeps the history beside it in the menu", async () => {
    environment();
    const sys = system();
    await startIsland(sys);
    const page = await startSettings(sys, "notifications");
    press(page.page.querySelector(".page-head")!, "Send a test");
    await advance(0);
    expect(sys.notices.list().map((n) => [n.source.label, n.title])).toEqual([["AiN", "This is a test notification"]]);
    const menu = [...page.page.querySelectorAll<HTMLElement>("nav button")].map((b) => b.textContent?.trim());
    expect(menu.slice(menu.indexOf("Notifications"), menu.indexOf("Notifications") + 3)).toEqual(["Notifications", "Notification history", "Shortcuts"]);
    expect(menu.filter((m) => m === "Notification history")).toHaveLength(1);
    // A child of Notifications: drawn as one, and its page leads back there.
    const child = page.page.querySelector<HTMLButtonElement>("nav button[data-widget=notifications]")!;
    expect(child.classList.contains("nav-child")).toBe(true);
    child.click();
    await advance(0);
    expect(page.page.querySelector(".crumbs")?.textContent).toBe("Notifications›");
  });
});

describe("Settings → General", () => {
  it("points to the Hidden style from where the old switch was", async () => {
    environment();
    const sys = system();
    const page = await startSettings(sys);
    press(page.field("Hide the pill")!, "Appearance");
    await advance(0);
    expect(location.hash).toBe("#appearance");
    expect(page.field("Pill style")).not.toBeNull();
  });
});

describe("Settings → Plugins", () => {
  it("turns a style file on: it loads, and becomes a choice in Appearance", async () => {
    environment();
    const sys = system();
    sys.addFile("neon.js", (island) => island.defineStyle({ id: "neon", label: "Neon", mount: () => ({ draw() {} }) }));
    await startIsland(sys);
    const page = await startSettings(sys, "plugins");
    const card = [...page.page.querySelectorAll<HTMLElement>(".card")].find((c) => c.textContent?.includes("neon.js"))!;
    card.querySelector<HTMLElement>("[role=switch]")?.click();
    await page.saved();
    expect((await sys.settings()).extensions).toEqual(["neon.js"]);
    const loaded = [...page.page.querySelectorAll<HTMLElement>(".card")].find((c) => c.querySelector("h2")?.textContent === "Neon");
    expect(loaded?.textContent).toContain("Pill style, chosen in Appearance.");
    await page.open("Appearance");
    expect([...page.page.querySelectorAll(".ui-select-option")].some((o) => o.textContent?.startsWith("Neon"))).toBe(true);
  });

  const cardOf = (page: ParentNode, title: string) => [...page.querySelectorAll<HTMLElement>(".card")].find((c) => c.querySelector("h2")?.textContent === title);
  const labels = (card: HTMLElement | undefined) => [...(card?.querySelectorAll(".field-label") ?? [])].map((l) => l.textContent);
  const orbit = (island: Sdk) =>
    island.definePlugin({
      id: "orbit",
      label: "Orbit",
      description: "A clock.",
      icon: "",
      slots: ["glance"],
      options: {
        ring: island.options.toggle("Seconds ring", true),
        face: island.options.choice("Face", "analog", [["analog", "Analog"], ["digital", "Digital"]]),
      },
      setup: () => ({ glance: () => null }),
    });

  it("sets a plugin's options right under its switch once it's on", async () => {
    environment();
    const sys = system();
    sys.addFile("orbit.js", orbit);
    await startIsland(sys);
    const page = await startSettings(sys, "plugins");
    const file = [...page.page.querySelectorAll<HTMLElement>(".card")].find((c) => c.textContent?.includes("orbit.js"))!;
    expect(labels(file)).toEqual([]);

    file.querySelector<HTMLElement>("[role=switch]")?.click();
    await page.saved();
    const card = cardOf(page.page, "Orbit")!;
    expect(labels(card)).toEqual(["Seconds ring", "Face"]);
    press(card, "Digital");
    card.querySelectorAll<HTMLElement>(".field [role=switch]")[0]?.click();
    await page.saved();
    expect((await sys.settings()).options.orbit).toEqual({ face: "digital", ring: false });

    // The same options, in Widgets.
    await page.open("Widgets");
    expect(labels(cardOf(page.page, "Orbit"))).toEqual(["Seconds ring", "Face"]);
  });

  it("hides them again when the plugin is turned off", async () => {
    environment();
    const sys = system();
    sys.addFile("orbit.js", orbit);
    const page = await startSettings(sys, "plugins");
    [...page.page.querySelectorAll<HTMLElement>(".card")].find((c) => c.textContent?.includes("orbit.js"))!.querySelector<HTMLElement>("[role=switch]")?.click();
    await page.saved();
    cardOf(page.page, "Orbit")!.querySelector<HTMLElement>(".card-head [role=switch]")?.click();
    await page.saved();
    const file = [...page.page.querySelectorAll<HTMLElement>(".card")].find((c) => c.textContent?.includes("orbit.js"));
    expect(labels(file)).toEqual([]);
  });

  it("sets a style file's options under its switch too", async () => {
    environment();
    const sys = system();
    sys.addFile("neon.js", (island) =>
      island.defineStyle({ id: "neon", label: "Neon", options: { glow: island.options.number("Glow", 4, { min: 0, max: 10 }) }, mount: () => ({ draw() {} }) }),
    );
    const page = await startSettings(sys, "plugins");
    [...page.page.querySelectorAll<HTMLElement>(".card")].find((c) => c.textContent?.includes("neon.js"))!.querySelector<HTMLElement>("[role=switch]")?.click();
    await page.saved();
    expect(labels(cardOf(page.page, "Neon"))).toEqual(["Glow"]);
  });
});

describe("Settings → Plugins → Community store", () => {
  const orbit = { id: "orbit-clock", name: "Orbit clock", description: "An analog clock.", repo: "https://github.com/o/r" };
  const orbitPlugin = (island: Sdk) =>
    island.definePlugin({ id: "orbit-clock", label: "Orbit clock", description: "An analog clock.", icon: "", slots: ["tab"], setup: () => ({ panel() {} }) });
  const storeCards = (page: ParentNode) => [...page.querySelectorAll<HTMLElement>(".store-card")];
  const offer = (page: ParentNode, name: string) => storeCards(page).find((c) => c.querySelector("h2")?.textContent === name)!;
  const fileCard = (page: ParentNode, file: string) => [...page.querySelectorAll<HTMLElement>(".card:not(.store-card)")].find((c) => c.textContent?.includes(file));
  const buttonOf = (card: HTMLElement, label: string) => [...card.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

  it("installs a store plugin off, and turning it on places it", async () => {
    environment();
    const sys = system();
    sys.addOffer(orbit, orbitPlugin);
    await startIsland(sys);
    const page = await startSettings(sys, "plugins");
    expect(fileCard(page.page, "orbit-clock/index.js")).toBeUndefined();

    press(offer(page.page, "Orbit clock"), "Install");
    await advance(0);
    expect(offer(page.page, "Orbit clock").textContent).toContain("Installed");
    expect(buttonOf(offer(page.page, "Orbit clock"), "Update")).toBeDefined();
    expect((await sys.settings()).extensions).toEqual([]);

    fileCard(page.page, "orbit-clock/index.js")!.querySelector<HTMLElement>("[role=switch]")?.click();
    await page.saved();
    expect((await sys.settings()).extensions).toEqual(["orbit-clock/index.js"]);
    expect((await sys.settings()).layout.tabs).toContain("orbit-clock");
  });

  it("offers an update for a plugin already in the folder", async () => {
    environment();
    const sys = system();
    sys.addOffer(orbit, orbitPlugin);
    sys.addFile("orbit-clock/index.js", orbitPlugin);
    const page = await startSettings(sys, "plugins");
    const card = offer(page.page, "Orbit clock");
    expect(card.querySelector(".badge")?.textContent).toBe("Installed");
    expect(buttonOf(card, "Update")).toBeDefined();
    expect(buttonOf(card, "Install")).toBeUndefined();
  });

  it("lists a plugin it can't install with why, and its repository still opens", async () => {
    environment();
    const sys = system();
    sys.addOffer(
      { id: "elsewhere", name: "Elsewhere", description: "Not on GitHub.", repo: "https://gitlab.com/o/r", problem: "only GitHub repositories can be installed from the app" },
      () => null as never,
    );
    const page = await startSettings(sys, "plugins");
    const card = offer(page.page, "Elsewhere");
    expect(card.classList).toContain("failed");
    expect(card.textContent).toContain("Install it by hand: only GitHub repositories can be installed from the app.");
    expect(buttonOf(card, "Install")?.disabled).toBe(true);
    press(card, "Repository");
    await advance(0);
    expect(sys.reposOpened).toEqual(["elsewhere"]);
  });

  it("disables every download while one runs", async () => {
    environment();
    const sys = system();
    sys.addOffer(orbit, orbitPlugin);
    sys.addOffer({ ...orbit, id: "other", name: "Other" }, () => null as never);
    const page = await startSettings(sys, "plugins");
    const release = sys.holdInstalls();
    press(offer(page.page, "Orbit clock"), "Install");
    await advance(0);
    expect(buttonOf(offer(page.page, "Orbit clock"), "Installing…")?.disabled).toBe(true);
    expect(buttonOf(offer(page.page, "Other"), "Install")?.disabled).toBe(true);
    release();
    await advance(0);
    expect(buttonOf(offer(page.page, "Other"), "Install")?.disabled).toBe(false);
    expect(buttonOf(offer(page.page, "Orbit clock"), "Update")).toBeDefined();
  });

  it("says why a download failed, adds nothing, and can try again", async () => {
    environment();
    const sys = system();
    sys.addOffer(orbit, orbitPlugin);
    const page = await startSettings(sys, "plugins");
    sys.breakStore("install", "couldn't reach raw.githubusercontent.com");
    press(offer(page.page, "Orbit clock"), "Install");
    await advance(0);
    expect(toasts()).toEqual(["[STORE_INSTALL] Couldn't install Orbit clock: couldn't reach raw.githubusercontent.com"]);
    expect(offer(page.page, "Orbit clock").textContent).not.toContain("couldn't reach");
    expect(buttonOf(offer(page.page, "Orbit clock"), "Install")?.disabled).toBe(false);
    expect(fileCard(page.page, "orbit-clock/index.js")).toBeUndefined();

    sys.breakStore("install", null);
    press(offer(page.page, "Orbit clock"), "Install");
    await advance(0);
    expect(toasts().at(-1)).toBe("[] Orbit clock is installed: turn it on above: ");
    expect(fileCard(page.page, "orbit-clock/index.js")).toBeDefined();
  });

  it("says why the store couldn't be read, and Refresh reads it again", async () => {
    environment();
    const sys = system();
    sys.addOffer(orbit, orbitPlugin);
    sys.breakStore("store", "couldn't reach raw.githubusercontent.com");
    const page = await startSettings(sys, "plugins");
    expect(toasts()).toEqual(["[STORE_READ] Couldn't read the community store: couldn't reach raw.githubusercontent.com"]);
    expect(page.page.textContent).toContain("The store isn't available right now. Refresh to try again.");
    expect(storeCards(page.page)).toHaveLength(0);

    sys.breakStore("store", null);
    press(page.page, "Refresh");
    await advance(0);
    expect(page.page.textContent).not.toContain("The store isn't available");
    expect(storeCards(page.page).map((c) => c.querySelector("h2")?.textContent)).toEqual(["Orbit clock"]);
  });

  it("names a plugin that's off by its store listing, or by its file, and shows the file", async () => {
    environment();
    const sys = system();
    sys.addOffer(orbit, orbitPlugin);
    sys.addFile("orbit-clock/index.js", orbitPlugin);
    sys.addFile("cpu-alarm.js", orbitPlugin);
    const page = await startSettings(sys, "plugins");
    await advance(0);
    const listed = fileCard(page.page, "orbit-clock/index.js")!;
    expect(listed.querySelector("h2")?.textContent).toBe("Orbit clock");
    expect(listed.textContent).toContain("An analog clock.");
    expect(listed.querySelector(".mono")?.textContent).toBe("orbit-clock/index.js");
    const loose = fileCard(page.page, "cpu-alarm.js")!;
    expect(loose.querySelector("h2")?.textContent).toBe("Cpu alarm");
    expect(loose.textContent).toContain("Turn it on to load it.");
  });

  it("shows the plugins folder with its buttons, above the installed plugins", async () => {
    environment();
    const page = await startSettings(system(), "plugins");
    const bar = page.page.querySelector<HTMLElement>(".folder-bar")!;
    expect(bar.querySelector(".mono")?.textContent).toBe("/plugins");
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Open", "Refresh"]);
    expect([...page.page.querySelectorAll(".subhead")].map((s) => s.textContent)).toEqual(["Installed", "Community store"]);
  });

  it("says when the store lists nothing", async () => {
    environment();
    const page = await startSettings(system(), "plugins");
    expect(page.page.textContent).toContain("The store has no plugins yet.");
  });
});

describe("Settings → Plugins → options the user fills in", () => {
  /** A weather plugin that needs an API key and a city; `seen` gets what it reads through its host. */
  const weather = (seen: { host?: { secret(key: string): Promise<string>; options(): Record<string, unknown> } } = {}) => (island: Sdk) =>
    island.definePlugin({
      id: "weather",
      label: "Weather",
      description: "The forecast.",
      icon: "",
      slots: ["glance"],
      options: {
        apiKey: island.options.secret("API key", { required: true, pattern: "[a-f0-9]{8}", invalid: "8 hex digits" }),
        city: island.options.text("City", "", { required: true, pattern: "[A-Za-z ]+", invalid: "a city name" }),
        port: island.options.number("Proxy port", 8080, { min: 1, max: 65535, box: true }),
        notes: island.options.text("Notes", "", { multiline: true }),
        tint: island.options.color("Tint", "#ff8800"),
      },
      setup: (_: unknown, host: never) => ((seen.host = host), { glance: () => null }),
    });
  const cardOf = (page: ParentNode, title: string) => [...page.querySelectorAll<HTMLElement>(".card")].find((c) => c.querySelector("h2")?.textContent === title)!;
  const fieldOf = (card: HTMLElement, label: string) => [...card.querySelectorAll<HTMLElement>(".field")].find((f) => f.querySelector(".field-label")?.textContent === label)!;
  const type = (el: HTMLElement | null, value: string, event: "change" | "input" = "change") => {
    (el as HTMLInputElement).value = value;
    el!.dispatchEvent(new Event(event));
  };
  const errorOf = (fieldEl: HTMLElement) => fieldEl.querySelector(".field-error")?.textContent ?? null;
  const turnOn = async (page: Awaited<ReturnType<typeof startSettings>>, file: string) => {
    [...page.page.querySelectorAll<HTMLElement>(".card")].find((c) => c.textContent?.includes(file))!.querySelector<HTMLElement>("[role=switch]")!.click();
    await page.saved();
  };

  it("keeps a secret in the credential store, never in the settings, and the plugin reads it", async () => {
    environment();
    const sys = system();
    const seen: Parameters<typeof weather>[0] = {};
    sys.addFile("weather.js", weather(seen));
    await sys.save((s) => ({ ...s, layout: { ...s.layout, glance: { left: ["weather"], right: [] } } }));
    await startIsland(sys);
    const page = await startSettings(sys, "plugins");
    await turnOn(page, "weather.js");
    await advance(0);
    const card = cardOf(page.page, "Weather");
    expect(card.querySelector<HTMLElement>(".needs-setup")?.hidden).toBe(false);
    expect(card.querySelector<HTMLElement>(".needs-setup")?.title).toBe("Still to fill in: API key, City");

    const key = fieldOf(card, "API key");
    const input = key.querySelector<HTMLInputElement>("input[type=password]")!;
    type(input, "not-hex", "input");
    press(key, "Save");
    await advance(0);
    expect(errorOf(key)).toBe("Expected 8 hex digits.");
    expect(await sys.secrets.get("weather", "apiKey")).toBeNull();

    type(input, "deadbeef", "input");
    press(key, "Save");
    await advance(0);
    expect(errorOf(key)).toBeNull();
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Saved: type a new one to replace it");
    expect(await sys.secrets.get("weather", "apiKey")).toBe("deadbeef");
    expect(JSON.stringify(await sys.settings())).not.toContain("deadbeef");
    expect(card.querySelector<HTMLElement>(".needs-setup")?.title).toBe("Still to fill in: City");

    await advance(1000);
    expect(await seen.host!.secret("apiKey")).toBe("deadbeef");
    press(key, "Remove");
    await advance(0);
    expect(await seen.host!.secret("apiKey")).toBe("");
  });

  it("doesn't save text or a number that doesn't fit, and says why", async () => {
    environment();
    const sys = system();
    sys.addFile("weather.js", weather());
    const page = await startSettings(sys, "plugins");
    await turnOn(page, "weather.js");
    const card = cardOf(page.page, "Weather");

    const city = fieldOf(card, "City");
    expect(errorOf(city)).toBeNull();
    type(city.querySelector("input"), "Paris 75");
    await page.saved();
    expect(errorOf(city)).toBe("Expected a city name.");
    expect((await sys.settings()).options.weather?.city).toBeUndefined();
    type(city.querySelector("input"), "  Paris ");
    await page.saved();
    expect(errorOf(city)).toBeNull();
    expect((await sys.settings()).options.weather?.city).toBe("Paris");

    const port = fieldOf(card, "Proxy port");
    type(port.querySelector("input"), "70000");
    await page.saved();
    expect(errorOf(port)).toBe("Between 1 and 65535.");
    expect((await sys.settings()).options.weather?.port).toBeUndefined();
    type(port.querySelector("input"), "3128");
    await page.saved();
    expect((await sys.settings()).options.weather?.port).toBe(3128);

    type(fieldOf(card, "Notes").querySelector("textarea"), "line one\nline two");
    await page.saved();
    expect((await sys.settings()).options.weather?.notes).toBe("line one\nline two");
  });

  it("puts every option back to its default, but keeps the secrets", async () => {
    environment();
    const sys = system();
    sys.addFile("weather.js", weather());
    await sys.secrets.set("weather", "apiKey", "deadbeef");
    await sys.save((s) => ({ ...s, extensions: ["weather.js"], options: { ...s.options, weather: { city: "Paris", port: 3128 } } }));
    const page = await startSettings(sys, "plugins");
    await advance(0);
    press(cardOf(page.page, "Weather"), "Reset to defaults");
    await page.saved();
    expect((await sys.settings()).options.weather).toBeUndefined();
    expect(await sys.secrets.get("weather", "apiKey")).toBe("deadbeef");
    expect(fieldOf(cardOf(page.page, "Weather"), "City").querySelector("input")?.value).toBe("");
  });

  it("sets a store plugin up before it's turned on, from the options its listing declares", async () => {
    environment();
    const sys = system();
    const options = {
      apiKey: { kind: "secret", label: "API key", required: true },
      city: { kind: "text", label: "City", default: "", required: true },
    };
    sys.addOffer({ id: "weather", name: "Weather", description: "The forecast.", repo: "https://github.com/o/r", options }, weather());
    const page = await startSettings(sys, "plugins");
    press([...page.page.querySelectorAll<HTMLElement>(".store-card")][0]!, "Install");
    await advance(0);

    const installed = [...page.page.querySelectorAll<HTMLElement>(".card:not(.store-card)")].find((c) => c.textContent?.includes("weather/index.js"))!;
    expect(installed.textContent).toContain("Set it up now: it uses these once turned on.");
    expect(installed.querySelector<HTMLElement>(".needs-setup")?.hidden).toBe(false);
    type(fieldOf(installed, "City").querySelector("input"), "Lyon");
    await page.saved();
    expect((await sys.settings()).options.weather).toEqual({ city: "Lyon" });
    expect((await sys.settings()).extensions).toEqual([]);

    // On, its own options take over, under the same id: what was set is there.
    await turnOn(page, "weather/index.js");
    expect(fieldOf(cardOf(page.page, "Weather"), "City").querySelector("input")?.value).toBe("Lyon");
  });
});

describe("Settings → Widgets", () => {
  it("changes a widget's option, and the pill shows it", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    await advance(1000);
    const page = await startSettings(sys, "widgets:clock");
    press(page.page.querySelector("#card-clock")!, "12-hour");
    await page.saved();
    await advance(1000);
    expect(island.glances()[0]).toMatch(/^0?9:41\sAM$/i);
  });
});

describe("A plugin's page", () => {
  /** A plugin whose page edits a note, opened from its settings panel; counts the times its page was left. */
  const notes = (left: { count: number }) => (island: Sdk) =>
    island.definePlugin({
      id: "notes",
      label: "Notes",
      description: "Notes.",
      icon: "",
      slots: ["tab"],
      options: { last: island.options.text("Last note", "") },
      settingsPanel(root, _services, host) {
        root.append(island.dom.button("Open notes", () => host.openPage({ id: "n1" })));
      },
      page(root, _services, host) {
        host.setTitle(`Note ${host.params.id ?? "new"}`);
        const input = island.dom.h("input", { class: "note" });
        root.append(
          island.dom.button("Back", () => host.close()),
          input,
          island.dom.button("Save", () => {
            host.setOptions({ last: input.value });
            host.close();
          }),
        );
        return () => void left.count++;
      },
      setup: () => ({ panel() {} }),
    });
  const heading = (root: ParentNode) => root.querySelector("h1")?.textContent;
  const cardOf = (page: ParentNode, title: string) =>
    [...page.querySelectorAll<HTMLElement>(".card")].find((c) => c.querySelector("h2")?.textContent === title || c.dataset.title === title);

  it("opens from its settings panel, keeps what's typed while Settings redraws, then saves and goes back", async () => {
    environment();
    const sys = system();
    const left = { count: 0 };
    sys.addFile("notes.js", notes(left));
    await sys.save((s) => ({ ...s, extensions: ["notes.js"] }));
    const page = await startSettings(sys, "widgets", { inApp: true });
    await advance(0);
    await page.open("Notes");
    press(cardOf(page.page, "Notes")!, "Open notes");
    await advance(0);
    // The whole window is the page's: no menu, its title on the window.
    expect(page.page.dataset.page).toBe("true");
    expect(document.title).toBe("Note n1");
    expect(location.hash).toBe("#page:notes?id=n1");

    const input = page.page.querySelector<HTMLInputElement>("input.note")!;
    input.value = "Buy milk";
    // Saved from elsewhere (the island): Settings redraws, the page stays as it is.
    await sys.save((s) => ({ ...s, general: { ...s.general, openDelay: 300 } }));
    await advance(0);
    expect(page.page.querySelector("input.note")).toBe(input);
    expect(left.count).toBe(0);

    press(page.page, "Save");
    await page.saved();
    expect((await sys.settings()).options.notes).toEqual({ last: "Buy milk" });
    expect(left.count).toBe(1);
    // Back on the plugin's own page in Settings, where it was opened from.
    expect(heading(page.page)).toBe("Notes");
    expect(page.page.dataset.page).toBe("false");
    expect(location.hash).toBe("#widgets:notes");
  });

  it("opens at a page asked for from elsewhere, and leaving it leads to the plugin's card", async () => {
    environment();
    const sys = system();
    const left = { count: 0 };
    sys.addFile("notes.js", notes(left));
    await sys.save((s) => ({ ...s, extensions: ["notes.js"] }));
    const page = await startSettings(sys, "page:notes?id=7", { inApp: true });
    await advance(0);
    expect(document.title).toBe("Note 7");
    press(page.page, "Back");
    await advance(0);
    expect(left.count).toBe(1);
    expect(heading(page.page)).toBe("Notes");
    expect(page.page.querySelector("nav [aria-current=page]")?.textContent?.trim()).toBe("Notes");
  });

  it("says when its plugin isn't turned on", async () => {
    environment();
    const sys = system();
    const page = await startSettings(sys, "page:ghost", { inApp: true });
    await advance(0);
    expect(page.page.querySelector(".lead")?.textContent).toBe("This plugin isn't turned on: see Plugins.");
  });
});
