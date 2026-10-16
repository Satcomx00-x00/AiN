import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests: the island's preview page and the settings page in a real browser, against the
 * dev server and the preview's fake backend. Real layout, CSS, pointer and animations.
 */
const PORT = 5180;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 720 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } }],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/preview.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
