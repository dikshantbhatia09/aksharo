import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env["WEB_PORT"] ?? 3000);
const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? `http://127.0.0.1:${PORT}`;

/**
 * Chromium **and** WebKit are both blocking lanes (10-build-plan section 5):
 * Safari is a large share of the Indian mobile audience and WebCodecs behaves
 * differently there, so a browser-native export that only works in Chrome is a
 * bug, not a nice-to-have.
 */
export default defineConfig({
  testDir: "./e2e",
  // The renderer's wasm and fonts are copies, written before the suite runs.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] !== undefined ? 2 : 0,
  workers: process.env["CI"] !== undefined ? 1 : undefined,
  reporter: process.env["CI"] !== undefined ? [["list"], ["html", { open: "never" }]] : [["list"]],
  // CanvasKit instantiates a 7 MB wasm module on the first paint.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    // `next dev` keeps the smoke test fast; A23 runs the full e2e suite against a
    // production build and the compose stack.
    command: `npx next dev --port ${String(PORT)}`,
    url: BASE_URL,
    reuseExistingServer: process.env["CI"] === undefined,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
