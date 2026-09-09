import { defineConfig, devices } from "@playwright/test";

/**
 * Ad-hoc QA sweep config: drives the ALREADY RUNNING docker e2e stack
 * (`docker-compose.test.yml`, web on 59924 / api on 59923) rather than
 * starting its own servers. Not part of `pnpm test:e2e`.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: "./results",
  reporter: [["list"]],
  use: {
    baseURL: process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:59924",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
