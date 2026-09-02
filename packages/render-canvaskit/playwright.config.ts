import { defineConfig, devices } from "@playwright/test";

/**
 * The browser lane for the CanvasKit backend.
 *
 * Chromium only, deliberately: this suite asks "does Skia-in-the-browser draw
 * the same pixels as Skia-in-Node from the same command list", and one browser
 * answers that. The cross-browser lane (chromium **and** webkit) belongs to
 * A18a's parity gate and to `apps/web`'s own e2e suite.
 */

const PORT = Number(process.env["RENDER_CANVASKIT_E2E_PORT"] ?? 4319);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/build-bundle.mjs",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] === undefined ? 0 : 2,
  workers: 1,
  reporter: process.env["CI"] === undefined ? [["list"]] : [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
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
