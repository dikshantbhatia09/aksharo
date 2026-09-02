import { defineConfig, devices } from "@playwright/test";

import { loadRepoEnv } from "./e2e/env";

/**
 * The suite drives the real app against the real API.
 *
 * Both servers are started here so `pnpm --filter @montaj/web test:e2e` works
 * from a cold shell: the API on its own port, reading the repository `.env`, and
 * the web app pointed at it. `reuseExistingServer` outside CI means a developer
 * who already has both running keeps their processes.
 *
 * Chromium **and** WebKit are blocking lanes (10-build-plan §5): Safari is a
 * large share of the Indian mobile audience and behaves differently enough that
 * a shell which only works in Chrome is a bug, not a nice-to-have.
 */

const env = loadRepoEnv();

const WEB_PORT = Number(env.WEB_PORT ?? 3914);
const API_PORT = Number(env.API_PORT ?? 3913);
const BASE_URL = env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${String(WEB_PORT)}`;
const API_ORIGIN = env.API_ORIGIN ?? `http://127.0.0.1:${String(API_PORT)}`;

/** Analytics must be *configured* for the consent test to prove anything. */
const POSTHOG_KEY = "phc_e2e_placeholder";
const POSTHOG_HOST = "https://posthog.e2e.invalid";

/**
 * The web server runs a production build, so it must not inherit
 * `NODE_ENV=development` from the repository `.env`: `next build` refuses a
 * non-standard value and fails while prerendering its own error page. The API
 * keeps it, because that is what puts the auth emails in the Redis dev outbox
 * this suite reads.
 */
const { NODE_ENV: _ignoredNodeEnv, ...webEnv } = env;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] !== undefined ? 2 : 0,
  workers: process.env["CI"] !== undefined ? 1 : 2,
  reporter: process.env["CI"] !== undefined ? [["list"], ["html", { open: "never" }]] : [["list"]],
  // A journey test signs up, waits for the confirmation email to reach the Redis
  // outbox, confirms and signs in; 60 s is tight for that under parallel load.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "./test-results",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    {
      // The API this shell talks to. Its own port and its own database
      // (`montaj_a13`), so it never collides with another work package's stack.
      // A compiled build, not `nest start --watch`: the watcher restarts the
      // process whenever it thinks a file changed, and a suite that loses the API
      // halfway through reports "could not reach the server" instead of the bug it
      // was looking for.
      // `nest build` rather than the package's `build` script: that one also runs
      // `prisma generate`, which rewrites a native DLL another API process may
      // still have open and fails with EPERM on Windows. The client is generated
      // by `postinstall` and does not need regenerating to run the suite.
      command: "pnpm --filter @montaj/api exec nest build && pnpm --filter @montaj/api start",
      url: `${API_ORIGIN}/health`,
      reuseExistingServer: process.env["CI"] === undefined,
      timeout: 420_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...env,
        API_PORT: String(API_PORT),
        WEB_ORIGIN: BASE_URL,
        API_ORIGIN,
        // The rate limits are per address (A04 §Rate limits). Each test uses its
        // own `X-Forwarded-For`, which the API only trusts when told to.
        TRUST_PROXY: "1",
        MONTAJ_SCHEDULER_DISABLED: "1",
      },
    },
    {
      // A production build, not `next dev`: on-demand compilation makes the first
      // hit to every route a several-second stall, which turns two parallel
      // workers into a suite full of flaky timeouts. It is also what the review
      // screenshots should show.
      command: `npx next build && npx next start --port ${String(WEB_PORT)}`,
      url: BASE_URL,
      // Never reused: reusing would skip the build in the same command and serve
      // whatever `.next` happened to be there, which is how a suite ends up
      // green against last week's code.
      reuseExistingServer: false,
      timeout: 420_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...webEnv,
        API_ORIGIN,
        WEB_ORIGIN: BASE_URL,
        POSTHOG_KEY,
        POSTHOG_HOST,
        FEATURE_FLAGS_JSON: env.FEATURE_FLAGS_JSON ?? "{}",
      },
    },
  ],
});

export { API_ORIGIN, BASE_URL, POSTHOG_HOST };
