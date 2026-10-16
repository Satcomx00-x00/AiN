// @vitest-environment happy-dom
/**
 * The settings page and the island side by side on one settings store, as in the app: what is
 * changed on the page is saved, and the island follows.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Sdk } from "../sdk";
import { advance, environment, pick, press, restore, startIsland, startSettings, system } from "./harness";

afterEach(restore);

describe("Settings → Appearance", () => {
  it("makes the pill large, and the island grows", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    const page = await startSettings(sys, "appearance");
    press(page.field("Size")!, "Large");
    await page.saved();
    expect((await sys.settings()).general.pillSize).toBe("large");
    expect(island.size()).toEqual({ width: "260px", height: "44px" });
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
    expect(offer(page.page, "Orbit clock").textContent).toContain("Couldn't install it: couldn't reach raw.githubusercontent.com");
    expect(offer(page.page, "Orbit clock").classList).toContain("failed");
    expect(fileCard(page.page, "orbit-clock/index.js")).toBeUndefined();

    sys.breakStore("install", null);
    press(offer(page.page, "Orbit clock"), "Install");
    await advance(0);
    expect(offer(page.page, "Orbit clock").textContent).not.toContain("Couldn't install it");
    expect(fileCard(page.page, "orbit-clock/index.js")).toBeDefined();
  });

  it("says why the store couldn't be read, and Refresh reads it again", async () => {
    environment();
    const sys = system();
    sys.addOffer(orbit, orbitPlugin);
    sys.breakStore("store", "couldn't reach raw.githubusercontent.com");
    const page = await startSettings(sys, "plugins");
    expect(page.page.querySelector(".note.failed")?.textContent).toBe("Couldn't read the store: couldn't reach raw.githubusercontent.com");
    expect(storeCards(page.page)).toHaveLength(0);

    sys.breakStore("store", null);
    press(page.page, "Refresh");
    await advance(0);
    expect(page.page.querySelector(".note.failed")).toBeNull();
    expect(storeCards(page.page).map((c) => c.querySelector("h2")?.textContent)).toEqual(["Orbit clock"]);
  });

  it("says when the store lists nothing", async () => {
    environment();
    const page = await startSettings(system(), "plugins");
    expect(page.page.textContent).toContain("The store has no plugins yet.");
  });
});

describe("Settings → Widgets", () => {
  it("changes a widget's option, and the pill shows it", async () => {
    environment();
    const sys = system();
    const island = await startIsland(sys);
    await advance(1000);
    const page = await startSettings(sys, "widgets");
    press(page.page.querySelector("#card-clock")!, "12-hour");
    await page.saved();
    await advance(1000);
    expect(island.glances()[0]).toMatch(/^0?9:41\sAM$/i);
  });
});
