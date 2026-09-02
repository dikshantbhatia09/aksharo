/**
 * Funds a workspace's credit balance for an e2e suite that runs against the
 * REAL ledger (`LedgerCreditsFacade`, no `CREDITS_FACADE` override) and
 * enqueues jobs that actually reserve — `transcripts.e2e-spec.ts`,
 * `exports-render.e2e-spec.ts`, and any future suite in the same position.
 *
 * B02 shipped `NoopCreditsFacade` as the frozen shape every A08-era e2e spec
 * wrote its fixtures against; those fixtures never gave a workspace real
 * money because the no-op never checked a balance for anything above the
 * free-tier daily cap. Once `CREDITS_FACADE` binds to the real ledger, a
 * workspace with a plan but no `credit_accounts` row has a balance of
 * exactly zero, and `reserve()` correctly refuses it (`credits/insufficient`,
 * 402) — see `apps/api/src/credits/README.md`.
 *
 * Goes through `app.get(CREDITS_FACADE)` — the SAME instance the app's own
 * HTTP requests resolve — rather than a hand-rolled `credit_accounts`/
 * `credit_lots`/`credit_ledger` insert: the ledger's own invariants
 * (`getOrCreateAccount`'s lazy upsert, balance = Σ lots = Σ ledger, one
 * ledger row per grant) are `LedgerCreditsFacade`'s job to keep, not a test
 * fixture's to reproduce by hand and risk drifting from.
 */
import { CREDITS_FACADE } from "../src/credits/credits.facade.js";

import type { CreditsFacade } from "../src/credits/credits.facade.js";
import type { INestApplication } from "@nestjs/common";

/**
 * Grants `tenths` to `workspaceId` through the app's own `CreditsFacade`.
 *
 * A suite that has overridden `CREDITS_FACADE` to `NoopCreditsFacade` (the
 * mechanics-only suites — `jobs.e2e-spec.ts`, `dlq.e2e-spec.ts`,
 * `billing.e2e-spec.ts`) may call this too: `grantLot` is part of the frozen
 * interface either way, and the no-op's paid-plan fixtures (`db.plans.set(WS,
 * "creator")`) never needed a balance in the first place — the no-op only
 * enforces the FREE-tier daily cap.
 */
export async function fundWorkspaceCredits(
  app: INestApplication,
  workspaceId: string,
  tenths: number,
  reason = "e2e fixture grant",
): Promise<void> {
  const credits = app.get<CreditsFacade>(CREDITS_FACADE);
  await credits.grantLot({ workspaceId, source: "grant", tenths, reason });
}

/** A generous default for a suite that just needs "enough", not an exact figure. */
export const AMPLE_TEST_CREDIT_TENTHS = 100_000;
