import { Client as PgClient } from "pg";

import { testUlid } from "./editor-fixtures";
import { loadRepoEnv } from "./env";

import type { Account } from "./fixtures";

const DATABASE_URL = loadRepoEnv()["DATABASE_URL"] ?? "";

/**
 * A fresh sign-up's workspace starts with no credit grant — only
 * `prisma/seed.ts`'s demo workspace gets one, and `sharedAccount` (per
 * worker, `fixtures.ts`) is a real sign-up. `seedEditorProject`'s transcribe
 * call costs 1.5 credits, so a worker running several of this file's tests
 * against the same shared account needs a balance, same shape as the seed
 * script's own demo grant (`credit_accounts` + one `credit_lots` row + the
 * matching `credit_ledger` row — 06's invariant 1: balance = Σ lots = Σ
 * ledger). This is the one non-HTTP step, exactly `editor-fixtures.ts`'s own
 * `insertProbedMedia` precedent for "not reachable over HTTP without a real
 * [billing] flow".
 */
export async function grantTimelineTestCredits(account: Account): Promise<void> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ workspace_id: string }>(
      `SELECT m.workspace_id FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE u.email = $1
        LIMIT 1`,
      [account.email],
    );
    const workspaceId = rows[0]?.workspace_id;
    if (workspaceId === undefined) return;

    const grantTenths = 2000; // 200 credits: ample for this file's tests plus retries.
    const accountId = testUlid();
    await client.query(
      `INSERT INTO credit_accounts (id, workspace_id, balance_tenths, monthly_grant_tenths, created_at)
       VALUES ($1, $2, $3, $3, now())
       ON CONFLICT (workspace_id) DO UPDATE SET balance_tenths = credit_accounts.balance_tenths + $3`,
      [accountId, workspaceId, grantTenths],
    );
    const { rows: acctRows } = await client.query<{ id: string }>(
      `SELECT id FROM credit_accounts WHERE workspace_id = $1`,
      [workspaceId],
    );
    const resolvedAccountId = acctRows[0]?.id ?? accountId;
    const lotId = testUlid();
    await client.query(
      `INSERT INTO credit_lots (id, account_id, source, granted_tenths, remaining_tenths, created_at)
       VALUES ($1, $2, 'grant', $3, $3, now())`,
      [lotId, resolvedAccountId, grantTenths],
    );
    await client.query(
      `INSERT INTO credit_ledger (id, account_id, delta_tenths, kind, ref_type, lot_id, balance_after_tenths, at)
       VALUES ($1, $2, $3, 'grant', 'plan', $4, $3, now())`,
      [testUlid(), resolvedAccountId, grantTenths, lotId],
    );
  } finally {
    await client.end();
  }
}
