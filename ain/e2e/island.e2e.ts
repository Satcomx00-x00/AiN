/**
 * The island in a real browser: real CSS, layout, pointer and animations. The preview page plays
 * music (a live activity that widens the pill) and shows the time and the CPU load.
 */
import { type PillSize, box, expect, greeted, openIsland, test, update } from "./fixtures";

test.describe("the pill sizes", () => {
  // Folded size with music playing (a live activity widens the pill by 96 px at Normal).
  const SIZES: [PillSize, number, number][] = [
    ["low", 160 + 60, 20],
    ["normal", 200 + 96, 32],
    ["large", 260 + 132, 44],
  ];

  for (const [size, width, height] of SIZES)
    test(`${size}: ${width}×${height}, with readable text and everything inside the pill`, async ({ page }) => {
      const island = await openIsland(page, { still: true, size });
      await expect.poll(() => box(island)).toMatchObject({ width, height, y: 0 });
      const measures = await island.evaluate((el) => {
        const glance = el.querySelector<HTMLElement>(".glance")!;
        const pill = el.getBoundingClientRect();
        const spots = [...glance.querySelectorAll<HTMLElement>(".g")].map((g) => g.getBoundingClientRect());
        return {
          font: parseFloat(getComputedStyle(glance).fontSize),
          ear: parseFloat(getComputedStyle(el, "::before").width),
          inside: spots.every((s) => s.width === 0 || (s.left >= pill.left - 0.5 && s.right <= pill.right + 0.5 && s.bottom <= pill.bottom + 0.5)),
        };
      });
      expect(measures.font).toBeGreaterThanOrEqual(10);
      expect(measures.ear).toBeLessThanOrEqual(height);
      expect(measures.inside).toBe(true);
    });

  test("text and icons grow with the pill", async ({ page }) => {
    const fonts: number[] = [];
    for (const size of ["low", "normal", "large"]) {
      const island = await openIsland(page, { still: true, size });
      fonts.push(await island.locator(".glance").evaluate((g) => parseFloat(getComputedStyle(g).fontSize)));
    }
    expect(fonts).toEqual([...fonts].sort((a, b) => a - b));
    expect(new Set(fonts).size).toBe(3);
  });
});

test.describe("the pill styles", () => {
  const STYLES: [string, number, number][] = [
    ["pill", 296, 32],
    ["solo", 140 + 96, 32],
    ["stub", 56, 14],
    ["sliver", 140, 6],
    ["hidden", 296, 32],
  ];

  for (const [style, width, height] of STYLES)
    test(`${style} draws at ${width}×${height}`, async ({ page }) => {
      const island = await openIsland(page, { still: true, style });
      await expect(island).toHaveAttribute("data-style", style);
      await expect.poll(() => box(island)).toMatchObject({ width, height });
    });

  test("the Stub shows a mark and no text, the Sliver a line and no text", async ({ page }) => {
    const stub = await openIsland(page, { still: true, style: "stub" });
    await expect(stub.locator(".glance .mark[data-kind=eq]")).toBeVisible();
    await expect(stub.locator(".glance .g-text")).toHaveText([""]);
    const sliver = await openIsland(page, { still: true, style: "sliver" });
    await expect(sliver.locator(".sliver-line i")).toBeVisible();
    await expect(sliver.locator(".glance .g-text")).toHaveCount(0);
  });

  test("switching style live resizes the pill", async ({ page }) => {
    const island = await openIsland(page, { still: true });
    await update(page, { style: "stub" });
    await expect.poll(() => box(island)).toMatchObject({ width: 56, height: 14 });
    await update(page, { style: "pill", pillSize: "large" });
    await expect.poll(() => box(island)).toMatchObject({ width: 392, height: 44 });
  });
});

test.describe("hover", () => {
  test("opens the island under the pointer, and folds it once the pointer leaves", async ({ page }) => {
    const island = await openIsland(page, { still: true });
    const b = await box(island);
    await page.mouse.move(b.x + b.width / 2, b.height / 2);
    await expect(island).toHaveAttribute("data-open", "true");
    await expect.poll(() => box(island)).toMatchObject({ width: 420, height: 188 });
    await expect(island.locator(".panel")).toBeVisible();
    await expect(island.locator("[role=tab]")).toHaveCount(11);
    await page.mouse.move(640, 600);
    await expect(island).toHaveAttribute("data-open", "false");
    await expect.poll(() => box(island)).toMatchObject({ width: 296, height: 32 });
  });

  test("opens below a low pill to the same panel", async ({ page }) => {
    const island = await openIsland(page, { still: true, size: "low", style: "sliver" });
    const b = await box(island);
    await page.mouse.move(b.x + b.width / 2, 2);
    await expect(island).toHaveAttribute("data-open", "true");
    await expect.poll(() => box(island)).toMatchObject({ width: 420, height: 20 + 156 });
  });

  test("a timer started from its tab counts down on the pill", async ({ page }) => {
    const island = await openIsland(page, { still: true });
    const b = await box(island);
    await page.mouse.move(b.x + b.width / 2, b.height / 2);
    await island.locator("#tab-timer").click();
    await island.locator("#panel-timer .chip", { hasText: /^1m$/ }).click();
    await island.locator("#panel-timer .primary").click();
    await page.mouse.move(640, 600);
    await expect(island).toHaveAttribute("data-open", "false");
    await expect(island.locator(".glance .g-text").nth(1)).toHaveText(/^0:5\d$/, { timeout: 4000 });
  });
});

test.describe("animations", () => {
  test("the startup animation plays, then gives way to the glances", async ({ page }) => {
    const island = await openIsland(page);
    await expect(island.locator(".hello-face")).toBeAttached();
    await greeted(page);
    await expect(island.locator(".glance .g-text").first()).toHaveText(/^\d{1,2}:\d{2}/);
  });

  test("a new size eases in: text, icons and the pill move together", async ({ page }) => {
    const island = await openIsland(page);
    await greeted(page);
    // Samples the pill on every frame while it changes size, however late the change starts.
    const frames = page.evaluate(
      () =>
        new Promise<{ height: number; scale: number }[]>((resolve) => {
          const el = document.querySelector("#island")!;
          const seen: { height: number; scale: number }[] = [];
          const start = performance.now();
          const sample = () => {
            seen.push({ height: el.getBoundingClientRect().height, scale: parseFloat(getComputedStyle(el).getPropertyValue("--scale")) });
            if (performance.now() - start < 3000 && seen.at(-1)!.height < 44) requestAnimationFrame(sample);
            else resolve(seen);
          };
          requestAnimationFrame(sample);
        }),
    );
    await update(page, { pillSize: "large" });
    const seen = await frames;
    expect(seen.some((f) => f.height > 32 && f.height < 44), "a height between the two sizes").toBe(true);
    expect(seen.some((f) => f.scale > 1 && f.scale < 1.375), "a scale between the two sizes").toBe(true);
    await expect.poll(() => box(island)).toMatchObject({ height: 44 });
    await expect.poll(() => island.evaluate((el) => getComputedStyle(el).getPropertyValue("--scale").trim())).toBe("1.375");
  });

  test("a new style pops in", async ({ page }) => {
    const island = await openIsland(page);
    await greeted(page);
    // Counts the animations the island starts on its glance row from now on.
    await island.evaluate((el) => {
      const glance = el.querySelector<HTMLElement>(".glance")!;
      const animate = glance.animate.bind(glance);
      Object.assign(window, { pops: 0 });
      glance.animate = (...args: Parameters<HTMLElement["animate"]>) => {
        (window as unknown as { pops: number }).pops++;
        return animate(...args);
      };
    });
    await update(page, { style: "solo" });
    await expect(island).toHaveAttribute("data-style", "solo");
    expect(await page.evaluate(() => (window as unknown as { pops: number }).pops)).toBe(1);
    expect(await island.locator(".glance").evaluate((g) => g.getAnimations().length)).toBe(1);
  });

  test("nothing moves for people who ask for reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const island = await openIsland(page);
    await page.waitForTimeout(300);
    await expect(island.locator(".hello-face")).toHaveCount(0);
    await update(page, { pillSize: "large" });
    await page.waitForTimeout(50);
    expect((await box(island)).height).toBe(44);
  });
});
