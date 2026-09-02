import { Client as PgClient } from "pg";

import { freshAccount, testUlid } from "./editor-fixtures";
import { loadRepoEnv } from "./env";
import { expect, expectNoSeriousA11yViolations, gotoHydrated, test } from "./fixtures";

import type { Page } from "@playwright/test";

/**
 * B06 acceptance: the sidebar chip and Subscription widget render the exact
 * 08 §4 copy ("3 of 3 publish days · L2 · 2 freezes left"), never render for
 * a holdout workspace, and pass axe on both chromium and webkit
 * (`playwright.config.ts`'s two projects run this file).
 *
 * The backend `feature_flags.streak_experiment` row and the workspace's
 * `streak_experiments` row are both out of reach of any authenticated HTTP
 * route (there is no admin flag-toggle endpoint yet, and `POST
 * /streak/test-hooks` only simulates weeks, not a level), so this suite
 * writes them directly with `pg`, the same pattern
 * `editor-fixtures.ts#insertProbedMedia` uses for the one piece of setup a
 * real HTTP flow cannot reach.
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

async function enableStreakFlag(): Promise<void> {
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO feature_flags (id, key, enabled) VALUES ($1, 'streak_experiment', true)
       ON CONFLICT (key) DO UPDATE SET enabled = true`,
      [testUlid()],
    );
  });
}

/**
 * The workspace id the signed-in browser's own session carries — the same
 * `/api/session/refresh` (same-origin, cookie-based) `editor-fixtures.ts`'s
 * `accessTokenFor` uses, so this works the same way in chromium and webkit.
 */
async function currentWorkspaceId(page: Page): Promise<string> {
  const body = await page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    if (!response.ok) return { workspaceId: null };
    return (await response.json()) as { workspaceId: string | null };
  });
  return body.workspaceId ?? "";
}

/** Force the workspace's streak row to a specific, display-worthy state. */
async function setStreakState(
  workspaceId: string,
  data: { level: number; freezesRemaining: number; holdout: boolean; paused: boolean },
): Promise<void> {
  const now = new Date();
  const day = now.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysSinceMonday);
  weekStart.setUTCHours(0, 0, 0, 0);

  await withDb(async (client) => {
    await client.query(
      `INSERT INTO streak_experiments
         (id, workspace_id, level, week_window_start, publish_days, consecutive_weeks,
          frozen, freezes_remaining, freezes_month, paused, holdout, credits_only, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '[]', 1, 0, $5, to_char(now(), 'YYYY-MM'), $6, $7, false, now(), now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         level = $3, week_window_start = $4, freezes_remaining = $5, paused = $6, holdout = $7,
         credits_only = false, updated_at = now()`,
      [
        testUlid(),
        workspaceId,
        data.level,
        weekStart.toISOString(),
        data.freezesRemaining,
        data.paused,
        data.holdout,
      ],
    );
    for (let i = 0; i < 3; i += 1) {
      const at = new Date(weekStart.getTime() + i * 86_400_000 + 3_600_000);
      await client.query(
        `INSERT INTO publish_events (id, workspace_id, surface, at) VALUES ($1, $2, 'web', $3)`,
        [testUlid(), workspaceId, at.toISOString()],
      );
    }
  });
}

/**
 * `StreakService#syncCreditsOnly` (B06b) re-derives `creditsOnly` from the
 * workspace's *actual current subscription* on every read — a plan the
 * fixture's own `INSERT ... credits_only = false` claims does not survive a
 * `GET /streak` for a genuinely free-plan workspace, because there is no
 * such thing as a free workspace with the L{level}/freezes reward copy in
 * this product (D52). `freshAccount` signs up onto the free plan with no
 * subscription row at all, so the level/freezes half of the chip's copy can
 * only ever be exercised by giving the workspace a real paid subscription
 * first, matching what actually earns that copy.
 */
async function givePaidSubscription(workspaceId: string): Promise<void> {
  await withDb(async (client) => {
    const plan = await client.query(`SELECT id FROM plans WHERE key = 'creator' LIMIT 1`);
    const planId = (plan.rows[0] as { id: string } | undefined)?.id;
    if (planId === undefined) throw new Error("creator plan seed missing");
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 86_400_000);
    await client.query(
      `INSERT INTO subscriptions
         (id, workspace_id, plan_id, status, interval, current_period_start, current_period_end)
       VALUES ($1, $2, $3, 'active', 'month', $4, $5)`,
      [testUlid(), workspaceId, planId, now.toISOString(), periodEnd.toISOString()],
    );
  });
}

async function disableStreakFlag(): Promise<void> {
  await withDb(async (client) => {
    await client.query(`UPDATE feature_flags SET enabled = false WHERE key = 'streak_experiment'`);
  });
}

test.describe("streak widget and sidebar chip (B06)", () => {
  test.skip(DATABASE_URL === "", "DATABASE_URL not resolved for this suite");

  // This suite is the only one that flips the global `streak_experiment` flag
  // on (there is no per-workspace toggle) — turn it back off once done so a
  // concurrently-running spec file never sees an unexpected chip.
  test.afterAll(async () => {
    if (DATABASE_URL !== "") await disableStreakFlag();
  });

  test("shows the exact copy on the sidebar chip and the Subscription widget, and is axe clean", async ({
    page,
  }) => {
    await enableStreakFlag();
    const account = await freshAccount(page, "streak-chip");
    await gotoHydrated(page, "/studio");

    const workspaceId = await currentWorkspaceId(page);
    test.skip(workspaceId === "", "could not resolve the signed-in workspace id");

    // The L{level}/freezes half of the copy only ever shows for a paid,
    // non-creditsOnly workspace (B06b) — give this one a real subscription
    // before the read model gets a chance to re-derive `creditsOnly` back to
    // `true` for what would otherwise still be a free-plan workspace.
    await givePaidSubscription(workspaceId);

    await setStreakState(workspaceId, {
      level: 2,
      freezesRemaining: 2,
      holdout: false,
      paused: false,
    });

    await page.reload();
    await page.waitForSelector('html[data-hydrated="true"]');

    const chip = page.getByTestId("streak-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("3 of 3 publish days · L2 · 2 freezes left");

    await gotoHydrated(page, "/billing");
    const widget = page.getByTestId("streak-widget-summary");
    await expect(widget).toBeVisible();
    await expect(widget).toContainText("3 of 3 publish days · L2 · 2 freezes left");

    await expectNoSeriousA11yViolations(page, "/billing with the streak widget");
    void account;
  });

  test("shows the paused copy, never a reset", async ({ page }) => {
    await enableStreakFlag();
    await freshAccount(page, "streak-paused");
    await gotoHydrated(page, "/studio");
    const workspaceId = await currentWorkspaceId(page);
    test.skip(workspaceId === "", "could not resolve the signed-in workspace id");

    await setStreakState(workspaceId, {
      level: 3,
      freezesRemaining: 0,
      holdout: false,
      paused: true,
    });
    await page.reload();
    await page.waitForSelector('html[data-hydrated="true"]');

    const chip = page.getByTestId("streak-chip-paused");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("streak paused — one export restores it");
    // Scoped to the chip itself, not the whole page: the sidebar's credit
    // meter legitimately shows "Resets {date}" (packages/ui's CreditMeter,
    // unrelated to the streak experiment) right alongside it, which a
    // page-wide `getByText(/reset/i)` also matches. What B06 acceptance
    // criterion actually guards is the streak copy itself never claiming a
    // "reset" — a freeze/pause recovers the streak, it never zeroes it.
    await expect(chip.getByText(/reset/i)).toHaveCount(0);
  });

  test("a holdout workspace never sees the chip or the widget", async ({ page }) => {
    await enableStreakFlag();
    await freshAccount(page, "streak-holdout");
    await gotoHydrated(page, "/studio");
    const workspaceId = await currentWorkspaceId(page);
    test.skip(workspaceId === "", "could not resolve the signed-in workspace id");

    await setStreakState(workspaceId, {
      level: 2,
      freezesRemaining: 2,
      holdout: true,
      paused: false,
    });
    await page.reload();
    await page.waitForSelector('html[data-hydrated="true"]');

    await expect(page.getByTestId("streak-chip")).toHaveCount(0);
    await expect(page.getByTestId("streak-chip-paused")).toHaveCount(0);

    await gotoHydrated(page, "/billing");
    await expect(page.getByTestId("streak-widget-slot")).toHaveCount(0);
  });
});
