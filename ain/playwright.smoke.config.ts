import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke tests: the production build (`dist`, from `vite build`), each of its windows opened with a
 * stand-in for the Tauri backend. Quick checks that what ships starts up and draws.
 */
const PORT = 5181;

export default defineConfig({
  testDir: "smoke",
  testMatch: "**/*.smoke.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  // The engines of the app's web views: WebView2 on Windows; WKWebView and WebKitGTK on macOS and Linux.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 720 } } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
