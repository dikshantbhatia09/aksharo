import { Client as PgClient } from "pg";

import { testUlid } from "./editor-fixtures";
import { loadRepoEnv } from "./env";

import type { Page } from "@playwright/test";

/**
 * Shared plumbing for the A19 export specs (`export.spec.ts`,
 * `export-fallback.spec.ts`) that is not general enough to belong in the
 * shared `editor-fixtures.ts` (owned by A15) — kept in this work package's
 * own e2e files.
 */

const DATABASE_URL = loadRepoEnv()["DATABASE_URL"] ?? "";

export async function accessTokenFromPage(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    const body = (await response.json()) as { accessToken: string };
    return body.accessToken;
  });
}

export async function workspaceIdFromPage(page: Page): Promise<string> {
  const workspaceId = await page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    const body = (await response.json()) as { workspaceId: string | null };
    return body.workspaceId;
  });
  if (workspaceId === null) throw new Error("session refresh returned no workspaceId");
  return workspaceId;
}

/**
 * A real `POST /signup` workspace gets its first monthly credit grant from a
 * scheduled job (`06-billing`) — disabled in this worktree per the setup
 * instructions (`MONTAJ_SCHEDULER_DISABLED=1`), so a freshly signed-up
 * workspace has a real, enforced zero balance and `POST
 * /projects/{id}/transcribe` 402s. This grants the same 20 credits
 * `apps/api/prisma/seed.ts` gives the seeded demo workspace, directly by SQL —
 * the same "one non-HTTP step" convention `editor-fixtures.ts`'s
 * `insertProbedMedia` already uses, not a shortcut invented for this test.
 */
export async function grantTestCredits(workspaceId: string, tenths = 200): Promise<void> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const accountId = testUlid();
    await client.query(
      `INSERT INTO credit_accounts (id, workspace_id, balance_tenths, monthly_grant_tenths)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (workspace_id) DO UPDATE SET balance_tenths = credit_accounts.balance_tenths + $3`,
      [accountId, workspaceId, tenths],
    );
    const row = await client.query<{ id: string }>(
      `SELECT id FROM credit_accounts WHERE workspace_id = $1`,
      [workspaceId],
    );
    const resolvedAccountId = row.rows[0]?.id ?? accountId;
    const lotId = testUlid();
    await client.query(
      `INSERT INTO credit_lots (id, account_id, source, granted_tenths, remaining_tenths)
       VALUES ($1, $2, 'grant', $3, $3)`,
      [lotId, resolvedAccountId, tenths],
    );
    await client.query(
      `INSERT INTO credit_ledger (id, account_id, delta_tenths, kind, ref_type, lot_id, balance_after_tenths)
       VALUES ($1, $2, $3, 'grant', 'e2e-fixture', $4, $3)`,
      [testUlid(), resolvedAccountId, tenths, lotId],
    );
  } finally {
    await client.end();
  }
}

/**
 * `editor-fixtures.ts`'s `insertProbedMedia` always writes a fictitious 90s
 * duration. Fine for specs that only need *a* probed media row; wrong for a
 * test whose manifest has to match a real, short fixture video. Corrects it
 * by SQL, confined to this work package's own test files.
 */
export async function correctFixtureMediaDuration(
  projectId: string,
  durationMs: number,
): Promise<void> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE media_assets SET duration_ms = $2 WHERE project_id = $1 AND role = 'primary'`,
      [projectId, durationMs],
    );
  } finally {
    await client.end();
  }
}
