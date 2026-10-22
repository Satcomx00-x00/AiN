/**
 * The shortcut windows in a real browser, on their preview data: the clipboard history popup, the
 * command palette, the zones overlay and the screen capture editor (a real canvas, a real pointer).
 */
import { expect, test } from "./fixtures";

test.describe("the clipboard popup", () => {
  test("searches the history and moves through it with the keyboard", async ({ page }) => {
    await page.goto("/popup.html#clipboard.history");
    const search = page.getByRole("combobox", { name: "Search clipboard history" });
    await expect(search).toBeFocused();
    const options = page.getByRole("option");
    await expect(options).toHaveCount(6);
    await search.fill("tauri");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText("https://v2.tauri.app/start/");
    await search.fill("");
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".pk-count")).toHaveText("6 of 6");
  });
});

test.describe("the command palette", () => {
  test("finds apps, works out a calculation, and switches modes on a prefix", async ({ page }) => {
    await page.goto("/popup.html#palette.open");
    const search = page.getByRole("combobox", { name: "Search apps, files and commands" });
    await expect(search).toBeFocused();
    const options = page.getByRole("option");
    await search.fill("vsc");
    await expect(options.first()).toContainText("Visual Studio Code");
    await search.fill("12 * (3 + 4)");
    await expect(options.first()).toContainText("= 84");
    await search.fill("> ls -la");
    await expect(page.locator(".pl-mode")).toHaveText("Terminal");
    await expect(options).toHaveCount(1);
    await search.fill("report");
    await expect(page.getByRole("option", { name: /Quarterly report\.pdf/ })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("the zones overlay", () => {
  test("numbers the zones as the picker and says how to pick", async ({ page }) => {
    await page.goto("/zones.html?pick");
    const zones = page.getByRole("button", { name: /^Zone \d$/ });
    await expect(zones).toHaveCount(3);
    await expect(page.getByRole("status")).toHaveText("Press 1–3 or click a zone · ← → screen 1 of 2 · Esc to cancel");
    const [left, middle] = [await zones.nth(0).boundingBox(), await zones.nth(1).boundingBox()];
    expect(middle!.width).toBeGreaterThan(left!.width * 1.9);
  });

  test("lights the zone under a dragged window", async ({ page }) => {
    await page.goto("/zones.html");
    await expect(page.getByRole("button", { name: "Zone 2" })).toHaveAttribute("data-lit", "true");
    await expect(page.getByRole("status")).toBeHidden();
  });
});

test.describe("the capture editor", () => {
  test("captures a dragged area, then offers the drawing tools", async ({ page }) => {
    await page.goto("/overlay.html#screenshot.capture");
    const stage = page.locator(".ed-stage");
    await expect(stage).toHaveAttribute("data-phase", "select");
    await expect(page.getByRole("status").first()).toContainText("Drag to capture an area");
    await page.mouse.move(300, 200);
    await page.mouse.down();
    await page.mouse.move(700, 450, { steps: 8 });
    await expect(page.locator(".ed-area-size")).toHaveText(/\d+ × \d+/);
    await page.mouse.up();
    await expect(stage).toHaveAttribute("data-phase", "edit");
    const bar = page.getByRole("toolbar", { name: "Annotate" });
    await expect(bar).toBeVisible();
    for (const tool of ["pen", "marker", "rect", "ellipse"]) await expect(bar.locator(`[data-tool=${tool}]`)).toBeVisible();
  });

  test("draws with the chosen tool, and undoes it", async ({ page }) => {
    await page.goto("/overlay.html#screenshot.capture");
    // A click without a drag takes the whole screen.
    await page.mouse.click(640, 360);
    const bar = page.getByRole("toolbar", { name: "Annotate" });
    await expect(bar).toBeVisible();
    await bar.locator("[data-tool=rect]").click();
    await expect(bar.locator("[data-tool=rect]")).toHaveAttribute("aria-pressed", "true");
    const inked = () =>
      page.locator(".ed-ink").evaluate((c: HTMLCanvasElement) => {
        const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
        return false;
      });
    expect(await inked()).toBe(false);
    const sheet = (await page.locator(".ed-sheet").boundingBox())!;
    await page.mouse.move(sheet.x + 60, sheet.y + 60);
    await page.mouse.down();
    await page.mouse.move(sheet.x + 220, sheet.y + 160, { steps: 6 });
    await page.mouse.up();
    // The ink is redrawn on the next frame.
    await expect.poll(inked).toBe(true);
    await bar.getByRole("button", { name: /^Undo/ }).click();
    await expect.poll(inked).toBe(false);
  });

  test("closes on Esc", async ({ page }) => {
    await page.goto("/overlay.html#screenshot.capture");
    await expect(page.locator(".ed-stage")).toHaveAttribute("data-phase", "select");
    await page.keyboard.press("Escape");
    // Outside the app there is no window to hide: the page stays, with nothing broken.
    await expect(page.locator(".ed-stage")).toBeAttached();
  });
});
