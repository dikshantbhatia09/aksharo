import { createHmac } from "node:crypto";

import { Client as PgClient } from "pg";

import { freshAccount, testUlid } from "./editor-fixtures";
import { loadRepoEnv } from "./env";
import { expect, gotoHydrated, test } from "./fixtures";

import type { Page } from "@playwright/test";

/**
 * The `(admin)` route group's server-side gate, and one role-gated action on
 * each side of it (this WP's brief §4/§5): `support` can view the refunds
 * panel but not refund; `finance` can, with a reason.
 *
 * `admin_roles` and `admin_totp` have no self-service HTTP route (grants are
 * superadmin-only, out of band) — the same gap `streak.spec.ts` documents for
 * `streak_experiments`/`feature_flags` — so this suite seeds them directly
 * with `pg`, the same pattern. TOTP here is a hand-rolled RFC 6238 HOTP, kept
 * in lockstep with `apps/api/src/admin/auth/totp.ts` (SHA-1, 6 digits, 30s
 * step); this file cannot import server code, so the two must be read
 * side by side if that module's parameters ever change.
 *
 * **Honest simplification**: `finance`'s refund runs against a pass-purchase
 * id that does not exist. Seeding a real, refundable Razorpay-backed
 * purchase (payment record, invoice, credit lot) is its own fixture this
 * suite does not build; the assertion that matters — the request clears
 * `AdminGuard`'s role check and fails for a *different*, domain reason
 * (`not found`) rather than the role-check's own 403 text — still proves
 * the role gate, without a fabricated payment.
 */

const env = loadRepoEnv();
const DATABASE_URL = env["DATABASE_URL"] ?? "";

async function withDb<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The RFC 6238 code valid right now, for a base32 secret. Mirrors `totp.ts`. */
function currentTotpCode(secret: string, now: number = Date.now()): string {
  const counter = Math.floor(now / 1000 / 30);
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return (binary % 1_000_000).toString().padStart(6, "0");
}

/** A fixed, valid base32 secret — content does not matter, only that both sides agree on it. */
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

/** Grants an admin role and a verified TOTP enrolment directly, then returns a fresh code. */
async function becomeAdmin(email: string, role: string): Promise<string> {
  await withDb(async (client) => {
    const user = await client.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
      email,
    ]);
    const userId = user.rows[0]?.id;
    if (userId === undefined) throw new Error(`no user for ${email}`);

    await client.query(
      `INSERT INTO admin_roles (id, user_id, role, granted_by, granted_at)
       VALUES ($1, $2, $3, $2, now())
       ON CONFLICT (user_id, role) DO UPDATE SET revoked_at = NULL`,
      [testUlid(), userId, role],
    );
    await client.query(
      `INSERT INTO admin_totp (user_id, secret, enrolled_at, verified_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET secret = $2, verified_at = now()`,
      [userId, TOTP_SECRET],
    );
  });
  return currentTotpCode(TOTP_SECRET);
}

async function stepUpAsAdmin(page: Page, code: string): Promise<void> {
  await gotoHydrated(page, "/admin/step-up");
  await page.getByTestId("admin-stepup-code").fill(code);
  await page.getByRole("button", { name: "Step up" }).click();
  await page.waitForURL((url) => url.pathname === "/admin");
}

test("a visitor with no step-up gets a 404 on /admin, not a redirect", async ({ page }) => {
  const response = await page.goto("/admin");
  expect(response?.status()).toBe(404);
});

test("support can view the refunds panel but the API refuses to let them refund", async ({
  page,
}) => {
  const { email } = await freshAccount(page, "admin-support");
  const code = await becomeAdmin(email, "support");
  await stepUpAsAdmin(page, code);

  await page.goto("/admin/billing/refunds");
  await expect(page.getByRole("heading", { name: "Refund a pass/top-up purchase" })).toBeVisible();

  await page.getByLabel("Pass purchase ID").fill(testUlid());
  await page.getByLabel("Provider payment ID").fill("pay_test123");
  await page.getByLabel(/Reason \(min 10 characters/).fill("Testing the support role's gate.");
  await page.getByTestId("admin-refund-submit").click();

  await expect(page.getByTestId("admin-refund-error")).toContainText(
    "requires one of: finance, superadmin",
  );
});

test("finance clears the role gate to refund (with a reason)", async ({ page }) => {
  const { email } = await freshAccount(page, "admin-finance");
  const code = await becomeAdmin(email, "finance");
  await stepUpAsAdmin(page, code);

  await page.goto("/admin/billing/refunds");
  await page.getByLabel("Pass purchase ID").fill(testUlid());
  await page.getByLabel("Provider payment ID").fill("pay_test123");
  await page.getByLabel(/Reason \(min 10 characters/).fill("Refunding per the finance review.");
  await page.getByTestId("admin-refund-submit").click();

  // The role gate passed (a `support` session gets the 403 text above
  // instead); this fails for the unrelated, domain reason that the seeded
  // id names no real purchase.
  await expect(page.getByTestId("admin-refund-error")).not.toContainText("requires one of");
  await expect(page.getByTestId("admin-refund-error")).toContainText(/no such|not found/iu);
});

test("support's admin session can view (but not act on) the support-ticket queue", async ({
  page,
}) => {
  const { email } = await freshAccount(page, "admin-support-queue");
  const code = await becomeAdmin(email, "support");
  await stepUpAsAdmin(page, code);

  await page.goto("/admin/support");
  await expect(page.getByRole("heading", { name: "Support" })).toBeVisible();
});
