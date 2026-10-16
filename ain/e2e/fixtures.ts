import { type Locator, type Page, test as base, expect } from "@playwright/test";

/**
 * Every test fails on an uncaught error or a console error in the page: a broken page often still
 * draws something, so what it logs is part of what is checked.
 */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
      page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
      await use(problems);
      expect(problems, "errors in the page").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export type PillSize = "low" | "normal" | "large";

/** Opens the island's preview page; `still` turns motion off, for exact sizes. */
export async function openIsland(page: Page, params: Record<string, string | true> = {}): Promise<Locator> {
  const query = Object.entries(params)
    .map(([k, v]) => (v === true ? k : `${k}=${encodeURIComponent(v)}`))
    .join("&");
  await page.goto(`/preview.html${query ? `?${query}` : ""}`);
  const island = page.locator("#island");
  await expect(island).toHaveAttribute("data-style", /.+/);
  return island;
}

/** The pill's box on screen, in CSS px. */
export async function box(island: Locator) {
  const b = await island.boundingBox();
  if (!b) throw new Error("the island isn't on screen");
  return { x: b.x, y: b.y, width: Math.round(b.width), height: Math.round(b.height) };
}

/** Changes general settings live, as the settings window would (the preview page offers it). */
export async function update(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => (window as unknown as { preview: { update(p: unknown): Promise<void> } }).preview.update(p), patch);
}

/** Waits for the startup animation to be over: its elements gone and the glances back. */
export async function greeted(page: Page): Promise<void> {
  await expect(page.locator(".hello-face, .sparkle-sky, .typewriter")).toHaveCount(0, { timeout: 8000 });
  await page.waitForTimeout(300);
}
