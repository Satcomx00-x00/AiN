/**
 * The README's pictures of the island's styles, sizes, startup animation and appearance settings,
 * taken from the preview pages over the Windows wallpaper, like the README's other pictures.
 * Run with `bun run screenshots`; they land in the repository's `img/` folder.
 */
import { existsSync, readFileSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";

const IMG = "../img";
const WALLPAPER = process.env.WALLPAPER ?? "C:\\Windows\\Web\\Wallpaper\\Windows\\img19.jpg";

/** Puts the wallpaper behind the page, when there is one on this machine. */
async function desktop(page: Page) {
  if (!existsSync(WALLPAPER)) return;
  await page.route("**/__wallpaper.jpg", (route) => route.fulfill({ body: readFileSync(WALLPAPER), contentType: "image/jpeg" }));
  await page.addStyleTag({ content: "body { background: url(/__wallpaper.jpg) center top / cover no-repeat !important; }" });
}

/** Opens the island's preview with motion off, once the glances show what they settle on. */
async function island(page: Page, params: string) {
  await page.goto(`/preview.html?still&${params}`);
  await desktop(page);
  const el = page.locator("#island");
  await expect(el).toHaveAttribute("data-style", /.+/);
  // The preview shows a dictation result for a few seconds first.
  await page.waitForTimeout(4500);
  return el;
}

/** A shot of `width`×`height` at the top center of the screen. */
const top = (page: Page, file: string, width: number, height: number) =>
  page.screenshot({ path: `${IMG}/${file}`, clip: { x: Math.round((page.viewportSize()!.width - width) / 2), y: 0, width, height } });

for (const style of ["pill", "solo", "stub", "sliver"])
  test(`style: ${style}`, async ({ page }) => {
    await island(page, `style=${style}`);
    await top(page, `style-${style}.png`, 465, 72);
  });

for (const size of ["low", "normal", "large"])
  test(`size: ${size}`, async ({ page }) => {
    await island(page, `size=${size}`);
    await top(page, `size-${size}.png`, 560, 84);
  });

test("startup animation", async ({ page }) => {
  await page.goto("/preview.html");
  await desktop(page);
  // Hello, at the moment its face is all there.
  await expect(page.locator(".hello-face")).toBeAttached();
  await page.waitForTimeout(1300);
  await top(page, "startup-hello.png", 465, 72);
});

test("settings: appearance", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.goto("/settings.html#appearance");
  await expect(page.locator("main h1")).toHaveText("Appearance");
  await page.locator(".field", { hasText: "Size" }).getByRole("radio", { name: "Normal" }).waitFor();
  await page.waitForTimeout(300);
  // Down to the shape settings: the theme grid below is shown in the General screenshots' style already.
  const shape = await page.locator(".card", { hasText: "Corner curve" }).boundingBox();
  const height = Math.round((shape?.y ?? 560) + (shape?.height ?? 0) + 24);
  await page.screenshot({ path: `${IMG}/settings-appearance.png`, clip: { x: 0, y: 0, width: 1000, height } });
});

for (const [section, hash, file, width] of [
  ["General", "general", "settings-general.png", 1000],
  // Wider, so the preview and the widget's settings sit side by side.
  ["Pill", "layout", "settings-pill.png", 1240],
  ["Shortcuts", "shortcuts", "settings-shortcuts.png", 1000],
  ["Widgets", "widgets", "settings-widgets.png", 1000],
] as const)
  test(`settings: ${section.toLowerCase()}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto(`/settings.html#${hash}`);
    await expect(page.locator("main h1")).toHaveText(section);
    // The Pill page with a widget's settings beside the preview.
    if (hash === "layout") await page.locator('.pill-widget[data-drag="clock"]').click();
    await page.waitForTimeout(400);
    // Down to the end of the section, at most a window's height.
    const end = await page.evaluate(() => Math.max(...[...document.querySelectorAll("main > *")].map((e) => e.getBoundingClientRect().bottom)));
    await page.screenshot({ path: `${IMG}/${file}`, clip: { x: 0, y: 0, width, height: Math.min(760, Math.max(420, Math.ceil(end) + 32)) } });
  });
