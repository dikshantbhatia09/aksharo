import { defineConfig, devices } from "@playwright/test";

/**
 * The browser lane for the font loader.
 *
 * Chromium only, deliberately: this suite asks "does a WOFF2 fetched from the
 * pack decompress, register into `FontRegistry`, and draw glyphs through
 * CanvasKit", and one browser answers that. Cross-browser parity belongs to
 * A18a's gate and to `apps/web`'s own suite.
 */

const PORT = Number(process.env["FONTS_E2E_PORT"] ?? 4321);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/build-bundle.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] === undefined ? 0 : 2,
  workers: 1,
  reporter: process.env["CI"] === undefined ? [["list"]] : [["list"], ["html", { open: "never" }]],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/server.mjs",
    url: `http://127.0.0.1:${String(PORT)}/`,
    reuseExistingServer: process.env["CI"] === undefined,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
