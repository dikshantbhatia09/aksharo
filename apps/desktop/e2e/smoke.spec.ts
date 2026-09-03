import path from "node:path";

import { test, expect, _electron as electron } from "@playwright/test";

/**
 * Playwright-Electron smoke suite (brief §8). Requires `pnpm build` first.
 * Not run by `pnpm test` (vitest) — invoke via `pnpm test:e2e`; it launches a
 * real Electron process and needs a display (or Xvfb on Linux CI).
 */
const MAIN_ENTRY = path.join(__dirname, "..", "dist", "main", "index.js");

test("launches, shows the offline page when unreachable, and exposes the preload API", async () => {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      // Reserved, unroutable TEST-NET-1 address (RFC 5737): guarantees the
      // load fails without depending on network flakiness.
      AKSHARO_DESKTOP_TEST_APP_URL: "https://192.0.2.1/",
    },
  });

  const window = await app.firstWindow();

  // Offline page rendered (did-fail-load -> showOfflinePage). No
  // waitForLoadState first: the initial load is the failing navigation to
  // the unroutable test address, and Chromium's connect timeout for that can
  // take tens of seconds, so the h1 assertion's own timeout is what we wait on.
  await expect(window.locator("h1")).toHaveText("Can't reach Aksharo", { timeout: 60_000 });

  // Preload API present and allowlisted (no raw ipcRenderer/Node leak).
  const exposed = await window.evaluate(() => {
    const api = (window as unknown as { aksharoDesktop?: Record<string, unknown> }).aksharoDesktop;
    return {
      hasApi: Boolean(api),
      hasIpcRenderer:
        typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer !== "undefined",
      hasProcess: typeof (window as unknown as { process?: unknown }).process !== "undefined",
      keys: api ? Object.keys(api).sort() : [],
    };
  });
  expect(exposed.hasApi).toBe(true);
  expect(exposed.hasIpcRenderer).toBe(false);
  expect(exposed.hasProcess).toBe(false);
  expect(exposed.keys).toEqual([
    "bridge",
    "deepLink",
    "engine",
    "openMediaDialog",
    "platform",
    "telemetry",
    "updates",
    "version",
  ]);

  await app.close();
});
