import { defineConfig } from "@playwright/test";

// Playwright-Electron smoke suite (brief §8): launch, offline page renders,
// preload API present, deep link dispatch. Requires a built `dist/` (run
// `pnpm build` first) and a real Electron runtime/display, so it is kept out
// of `pnpm test` (vitest) and run separately via `pnpm test:e2e`.
export default defineConfig({
  testDir: "./e2e",
  // The offline-page scenario deliberately points at an unroutable address
  // (RFC 5737 TEST-NET-1); Chromium's own connect timeout for that can take
  // ~20-30s before `did-fail-load` fires, on top of Electron's own startup.
  timeout: 90_000,
  retries: 0,
  reporter: [["list"]],
  workers: 1,
});
