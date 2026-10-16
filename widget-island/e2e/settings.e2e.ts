/**
 * The settings page in a real browser (settings live in memory outside the app): the pill's style
 * and size controls, with the mouse and the keyboard.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const field = (page: Page, label: string) => page.locator(".field").filter({ has: page.locator(".field-label", { hasText: new RegExp(`^${label}$`) }) });

async function appearance(page: Page) {
  await page.goto("/settings.html");
  await page.locator("nav button", { hasText: "Appearance" }).click();
  await expect(page.locator("main h1")).toHaveText("Appearance");
}

test("opens on General, and every section draws", async ({ page }) => {
  await page.goto("/settings.html");
  await expect(page.locator("main h1")).toHaveText("General");
  for (const section of ["Appearance", "Layout", "Shortcuts", "Widgets", "Plugins", "About"]) {
    await page.locator("nav button", { hasText: section }).click();
    await expect(page.locator("main h1")).toHaveText(section);
  }
});

test("lists the five styles, each with a line about it", async ({ page }) => {
  await appearance(page);
  await field(page, "Pill style").locator(".ui-select-trigger").click();
  const options = field(page, "Pill style").locator(".ui-select-option");
  await expect(options).toHaveCount(5);
  await expect(options.locator(".ui-select-detail")).toHaveCount(5);
  await expect(options.first()).toContainText("Pill");
});

test("picking Hidden asks how long to wait, and saves", async ({ page }) => {
  await appearance(page);
  await expect(field(page, "Show after")).toHaveCount(0);
  await field(page, "Pill style").locator(".ui-select-trigger").click();
  await page.locator(".ui-select-option", { hasText: "Hidden" }).click();
  await expect(field(page, "Show after")).toBeVisible();
  await expect(page.locator(".status")).toHaveText("Saved");
});

test("the style can be picked with the keyboard", async ({ page }) => {
  await appearance(page);
  const trigger = field(page, "Pill style").locator(".ui-select-trigger");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText("Solo");
});

test("the size is one of three, and the choice sticks", async ({ page }) => {
  await appearance(page);
  const size = field(page, "Size");
  await size.getByRole("radio", { name: "Large" }).click();
  await expect(size.getByRole("radio", { name: "Large" })).toHaveAttribute("aria-checked", "true");
  await expect(size.getByRole("radio", { checked: true })).toHaveCount(1);
  await expect(page.locator(".status")).toHaveText("Saved");
  await page.locator("nav button", { hasText: "General" }).click();
  await page.locator("nav button", { hasText: "Appearance" }).click();
  await expect(field(page, "Size").getByRole("radio", { name: "Large" })).toHaveAttribute("aria-checked", "true");
});

test("General points to the Hidden style", async ({ page }) => {
  await page.goto("/settings.html");
  await field(page, "Hide the pill").getByRole("button", { name: "Appearance" }).click();
  await expect(page.locator("main h1")).toHaveText("Appearance");
  await expect(page).toHaveURL(/#appearance$/);
});
