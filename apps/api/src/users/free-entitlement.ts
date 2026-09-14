import { ulid } from "ulid";

import type { PrismaTransaction } from "../common/prisma/prisma.service.js";
import type { $Enums } from "@prisma/client";

/**
 * Give a brand-new workspace the Free plan it was promised.
 *
 * Until this existed, `POST /auth/signup` and the Google callback created the
 * user, the workspace, the membership and the consent rows — and stopped. The
 * Free plan's 20 monthly credits (`prisma/seed-data.ts`) were only ever written
 * by `prisma/seed.ts`, and only for the demo workspace, so every real account
 * started with no subscription, no credit account and a zero balance. Sign-up
 * looked fine, upload worked, and transcription then silently refused to start,
 * because `AutoTranscribeTrigger` requires credits. That is the first customer
 * journey failing at the exact moment the product delivers its value
 * (launch-readiness P0-07).
 *
 * Deliberately written against a bare {@link PrismaTransaction} rather than
 * through `LedgerCreditsFacade.grantLot`: this runs *inside* the sign-up
 * transaction, so a grant that fails must roll the user back with it, and
 * `users/` importing `credits/` would close an import cycle (credits already
 * reaches users through the notifier).
 *
 * Idempotent by construction so it can also backfill the accounts created
 * before it existed (`scripts/backfill-free-entitlement.ts`): it re-reads its
 * own rows and returns `"already_provisioned"` rather than granting twice. The
 * ledger is append-only (06 invariant 1), so double-granting is not something a
 * later correction can tidy up.
 */

/** `credit_ledger.ref_type` for a plan grant, matching `LedgerCreditsFacade`. */
const REF_TYPE_GRANT = "grant";

export type FreeEntitlementOutcome =
  | { readonly status: "provisioned"; readonly grantedTenths: number }
  | { readonly status: "already_provisioned"; readonly grantedTenths: number };

/**
 * Thrown when the `free` plan row is missing — an unseeded database.
 *
 * Fail closed rather than best-effort: a sign-up that quietly produces an
 * account with no entitlement is precisely the failure this module exists to
 * remove, and it is invisible until a user tries to transcribe. A loud 500 on
 * the first sign-up after a bad deploy is recoverable; a cohort of silently
 * unusable accounts is not.
 */
export class MissingFreePlanError extends Error {
  constructor() {
    super(
      'No plan with key "free" exists. Run the plan seed (`pnpm --filter @montaj/api db:migrate`) ' +
        "before accepting sign-ups: a new workspace cannot be given its monthly credit grant.",
    );
    this.name = "MissingFreePlanError";
  }
}

export interface ProvisionFreeEntitlementInput {
  readonly workspaceId: string;
  readonly currency: $Enums.Currency;
  /** Start of the first billing period. Defaults to now. */
  readonly at?: Date;
}

/**
 * Create the Free subscription, credit account, grant lot and ledger row for
 * `workspaceId`, in the caller's transaction.
 *
 * Every row is written so invariant 1 holds the moment the transaction commits:
 * `balance_tenths` = Σ lot remainders = Σ ledger deltas.
 */
export async function provisionFreeEntitlement(
  tx: PrismaTransaction,
  input: ProvisionFreeEntitlementInput,
): Promise<FreeEntitlementOutcome> {
  const now = input.at ?? new Date();
  const periodEnd = addMonths(now, 1);

  const plan = await tx.plan.findUnique({
    where: { key: "free" },
    select: { id: true, creditsPerMonthTenths: true },
  });
  if (plan === null) throw new MissingFreePlanError();

  const grantTenths = plan.creditsPerMonthTenths;

  // The credit account carries the unique workspace key, so it is the one row
  // that can decide "has this workspace already been provisioned?" without a
  // race: two concurrent calls both try to insert it and exactly one wins.
  const existingAccount = await tx.creditAccount.findUnique({
    where: { workspaceId: input.workspaceId },
    select: { id: true, monthlyGrantTenths: true },
  });
  if (existingAccount !== null) {
    return { status: "already_provisioned", grantedTenths: existingAccount.monthlyGrantTenths };
  }

  const accountId = ulid();
  await tx.creditAccount.create({
    data: {
      id: accountId,
      workspaceId: input.workspaceId,
      balanceTenths: grantTenths,
      monthlyGrantTenths: grantTenths,
      // The anniversary tick (`LedgerCreditsFacade.resetMonthlyGrants`) picks the
      // account up from here, so the second month's grant needs no extra wiring.
      grantResetAt: periodEnd,
    },
  });

  // A zero-credit plan still gets the subscription and the account — it is a
  // real entitlement row that `EntitlementsService` reads — but writing a
  // zero-value lot and ledger row would be noise in an append-only ledger.
  if (grantTenths > 0) {
    const lotId = ulid();
    await tx.creditLot.create({
      data: {
        id: lotId,
        accountId,
        source: "grant",
        grantedTenths: grantTenths,
        remainingTenths: grantTenths,
        expiresAt: periodEnd,
      },
    });

    await tx.creditLedger.create({
      data: {
        id: ulid(),
        accountId,
        deltaTenths: grantTenths,
        kind: "grant",
        refType: REF_TYPE_GRANT,
        refId: plan.id,
        lotId,
        balanceAfterTenths: grantTenths,
        at: now,
      },
    });
  }

  await tx.subscription.create({
    data: {
      id: ulid(),
      workspaceId: input.workspaceId,
      planId: plan.id,
      // `none`: nothing was charged and no provider mandate exists. B01 creates a
      // razorpay-backed row only when a paid plan is actually bought.
      provider: "none",
      status: "active",
      interval: "month",
      currency: input.currency,
      listPriceMinor: 0,
      taxInclusive: true,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      seats: 1,
    },
  });

  return { status: "provisioned", grantedTenths: grantTenths };
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}
