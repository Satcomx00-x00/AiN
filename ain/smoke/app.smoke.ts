/**
 * Smoke tests of the production build: each window of the app, as `vite build` ships it, opened
 * with a stand-in for the Tauri backend. Each must start without errors, ask the backend only for
 * commands it has, and draw what it is for.
 */
import { expect, test } from "../e2e/fixtures";
import { calls, withBackend } from "./tauri";

test.afterEach(async ({ page }) => {
  expect((await calls(page)).unknown, "commands the backend doesn't have").toEqual([]);
});

test("the island starts, shows the time and the CPU load, and sizes its window", async ({ page }) => {
  await withBackend(page);
  await page.goto("/index.html");
  const island = page.locator("#island");
  await expect(island).toHaveAttribute("data-style", "pill");
  await expect(island.locator(".glance .g-text")).toHaveText([/^\d{1,2}:\d{2}/, "42%"], { timeout: 8000 });
  const layout = (await calls(page)).commands.filter((c) => c.cmd === "plugin:island|layout");
  expect(layout.at(-1)?.args).toMatchObject({ region: { width: 220, height: 32 } });
});

test("the island starts with stored settings: a large Stub", async ({ page }) => {
  await withBackend(page, { settings: { version: 1, general: { style: "stub", pillSize: "large", greeting: "none" } } });
  await page.goto("/index.html");
  const island = page.locator("#island");
  await expect(island).toHaveAttribute("data-style", "stub");
  await expect.poll(async () => (await island.boundingBox())?.height).toBe(19);
});

test("the settings window draws every section and saves a change", async ({ page }) => {
  await withBackend(page);
  await page.goto("/settings.html");
  for (const section of ["General", "Appearance", "Layout", "Shortcuts", "Widgets", "Plugins", "About"]) {
    await page.locator("nav button", { hasText: section }).click();
    await expect(page.locator("main h1")).toHaveText(section);
  }
  // About ends on the updater's card, filled from the backend.
  const updates = page.locator("#card-updates");
  await expect(updates.locator("h2")).toHaveText("AiN 0.2.0");
  await expect(updates.locator(".update-badge")).toHaveText("Up to date");
  await page.locator("nav button", { hasText: "Plugins" }).click();
  await expect(page.locator(".store-card h2")).toHaveText(["Orbit clock"]);
  await page.locator("nav button", { hasText: "Appearance" }).click();
  await page.getByRole("radio", { name: "Large" }).click();
  await expect(page.locator(".status")).toHaveText("Saved");
  const saved = (await calls(page)).commands.filter((c) => c.cmd === "plugin:settings|set").at(-1)?.args as { value: { general: { pillSize: string } } };
  expect(saved.value.general.pillSize).toBe("large");
});

test("the clipboard popup lists what was copied", async ({ page }) => {
  await withBackend(page);
  await page.goto("/popup.html#clipboard.history");
  await expect(page.getByText("hello from the clipboard")).toBeVisible();
});

test("the command palette lists the installed apps and starts one", async ({ page }) => {
  await withBackend(page);
  await page.goto("/popup.html#palette.open");
  await page.getByRole("combobox", { name: "Search apps, files and commands" }).fill("fire");
  await expect(page.getByRole("option").first()).toContainText("Firefox");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page)).commands.filter((c) => c.cmd === "plugin:palette|launch").map((c) => c.args)).toEqual([{ id: "firefox.desktop" }]);
});

test("the capture overlay opens without a capture to show", async ({ page }) => {
  await withBackend(page);
  await page.goto("/overlay.html#screenshot.capture");
  await page.waitForTimeout(500);
  expect((await calls(page)).commands.map((c) => c.cmd)).toContain("plugin:capture|latest");
});
