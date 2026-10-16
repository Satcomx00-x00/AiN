import { defineConfig } from "vitest/config";

/**
 * Unit and integration tests (`src/**\/*.test.ts`, the integration flows under `src/integration`).
 * The browser tests run with Playwright instead: `e2e/` and `smoke/`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Generated IPC bindings, the dev-only preview, and the test harness itself.
      exclude: ["src/**/*.test.ts", "src/**/bindings.ts", "src/shell/bindings/**", "src/preview/**", "src/integration/**"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "coverage",
    },
  },
});
