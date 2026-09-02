import AxeBuilder from "@axe-core/playwright";
import { test as base, expect } from "@playwright/test";
import Redis from "ioredis";

import { loadRepoEnv } from "./env";

import type { BrowserContext, Page } from "@playwright/test";

/**
 * The suite's shared machinery: a per-test source address, the development mail
 * outbox, and an axe pass every screen test can call in one line.
 */

const env = loadRepoEnv();

export const API_ORIGIN = env["API_ORIGIN"] ?? "http://127.0.0.1:3913";
const REDIS_URL = env["REDIS_URL"] ?? "redis://localhost:6379";

/** A04 writes every auth email here outside production. Not namespaced. */
const DEV_OUTBOX_KEY = "montaj:auth:dev-outbox";

export interface OutboxMessage {
  to: string;
  template: "email_verification" | "magic_link" | "device_approved";
  link: string;
  token?: string;
  at: string;
}

/**
 * Read the development mail outbox.
 *
 * The Redis instance is shared with the other work packages' local APIs and the
 * key is not prefixed, so every read filters by the address the test made up.
 * The list keeps only the newest 50 messages, so a slow reader on a busy Redis
 * can miss its own — hence the short poll interval rather than a long sleep.
 */
export async function readOutbox(address: string): Promise<OutboxMessage[]> {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await redis.connect();
    const raw = await redis.lrange(DEV_OUTBOX_KEY, 0, -1);
    return raw
      .map((entry) => JSON.parse(entry) as OutboxMessage)
      .filter((message) => message.to.toLowerCase() === address.toLowerCase());
  } finally {
    redis.disconnect();
  }
}

/** Wait for the newest message of a template, then return its single-use token. */
export async function waitForToken(
  address: string,
  template: OutboxMessage["template"],
  timeoutMs = 45_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = await readOutbox(address);
    const message = messages.find((entry) => entry.template === template);
    if (message?.token !== undefined && message.token !== "") return message.token;
    if (Date.now() > deadline) {
      throw new Error(`no ${template} message for ${address} within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Distinct addresses per test, so the per-account rate limits never collide. */
export function uniqueEmail(label: string): string {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `a13-${label}-${suffix}@example.test`;
}

/**
 * A per-run offset, so two runs inside the same ten-minute window do not reuse
 * the same synthetic addresses and exhaust the API rate-limit buckets.
 */
const RUN_OFFSET = Math.floor(Math.random() * 250);
let addressCounter = 0;

/**
 * A source address for this test.
 *
 * The API's rate limits are per IP (A04 §Rate limits) and a suite that signs up
 * a dozen accounts from one address exhausts `auth:signup:ip` halfway through.
 * `TRUST_PROXY=1` in the Playwright-managed API makes it read this header.
 */
function nextTestAddress(workerIndex: number): string {
  addressCounter += 1;
  const octet = ((workerIndex * 61 + addressCounter * 7) % 250) + 2;
  return `198.51.${String(RUN_OFFSET + 1)}.${String(octet)}`;
}

export interface Account {
  email: string;
  password: string;
}

/**
 * One confirmed account per worker.
 *
 * A test that only needs *a* session should not create an account: every sign-up
 * puts a message in a 50-entry Redis list that every work package's local API
 * shares, and eighteen of them in one run means a slow reader misses its own.
 * Signing up once per worker and signing in per test is both faster and the
 * reason the suite stopped being flaky. Tests that exercise sign-up itself, or
 * that change a consent, still create their own.
 */
export const test = base.extend<{ context: BrowserContext }, { sharedAccount: Account }>({
  context: async ({ browser }, use, testInfo) => {
    const context = await browser.newContext({
      extraHTTPHeaders: { "X-Forwarded-For": nextTestAddress(testInfo.workerIndex) },
    });
    await use(context);
    await context.close();
  },

  sharedAccount: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext({
        extraHTTPHeaders: { "X-Forwarded-For": nextTestAddress(workerInfo.workerIndex) },
      });
      const page = await context.newPage();
      const account = await signUpAndVerify(page, `shared${String(workerInfo.workerIndex)}`);
      await context.close();
      await use(account);
    },
    { scope: "worker" },
  ],
});

export { expect };

/** Sign an existing account in and land wherever `next` says. */
export async function signIn(page: Page, account: Account, next = "/studio"): Promise<void> {
  await gotoHydrated(page, `/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/**
 * Navigate and wait until React has hydrated.
 *
 * Before hydration the forms are server-rendered HTML: a value typed into a
 * controlled input is thrown away when React attaches and writes component
 * state back. A person cannot type that fast; Playwright can, and WebKit hydrates
 * late enough that it did — the first field of the sign-up form arrived empty.
 */
export async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForSelector('html[data-hydrated="true"]', { state: "attached" });
}

/**
 * Run axe on the page and fail on anything serious or critical.
 *
 * WCAG 2.1 A and AA only: the shell targets AA contrast (08 §6), and pulling in
 * "best-practice" rules would fail the build on advice rather than on a defect.
 */
export async function expectNoSeriousA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );

  const summary = serious
    .map(
      (violation) =>
        `${violation.id} (${String(violation.impact)}): ${violation.help}\n  ${violation.nodes
          .map((node) => node.target.join(" "))
          .join("\n  ")}`,
    )
    .join("\n");

  expect(serious, `${label} has serious or critical axe violations:\n${summary}`).toEqual([]);
}

/** Sign up, confirm the address from the outbox, and land inside the shell. */
export async function signUpAndVerify(
  page: Page,
  label: string,
  options: { analytics?: boolean; memory?: boolean; dateOfBirth?: string } = {},
): Promise<{ email: string; password: string }> {
  const email = uniqueEmail(label);
  const password = "correct-horse-battery-staple";

  await gotoHydrated(page, "/signup");
  await page.getByLabel("Name").fill("Priya Sharma");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByTestId("signup-continue").click();

  await page.getByLabel("Date of birth").fill(options.dateOfBirth ?? "1995-04-12");
  if (options.analytics === true) await page.getByTestId("consent-analytics").click();
  if (options.memory === true) await page.getByTestId("consent-memory").click();
  await page.getByTestId("age-consent-submit").click();

  await expect(page.getByTestId("signup-sent")).toBeVisible();

  // Confirming the address does not sign anyone in (A04): the link only proves
  // the mailbox. Signing in afterwards is what the screen tells the user to do.
  const token = await waitForToken(email, "email_verification");
  await page.goto(`/verify?token=${encodeURIComponent(token)}`);
  await page.waitForURL(/\/login/);
  await waitForHydration(page);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL(/\/onboarding/);

  return { email, password };
}
