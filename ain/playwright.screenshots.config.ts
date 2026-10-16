import { defineConfig, devices } from "@playwright/test";

/** Takes the README's pictures (`screenshots/`): not a test suite, run it with `bun run screenshots`. */
const PORT = 5182;

export default defineConfig({
  testDir: "screenshots",
  testMatch: "**/*.shots.ts",
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${PORT}`, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: "en-GB" },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/preview.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
