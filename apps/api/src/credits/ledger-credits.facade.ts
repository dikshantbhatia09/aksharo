import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { CreditsLowBalanceNotifier } from "./credits-low-balance.notifier.js";
import { CREDIT_ERROR_CODES } from "./credits.errors.js";
import { CreditsInsufficientError } from "./credits.facade.js";
import {
  allocateLots,
  giveBackLots,
  mergeAllocations,
  proportionalSplit,
} from "./lot-allocation.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type {
  CreditLotSource,
  CreditsFacade,
  GrantLotInput,
  GrantLotResult,
  ReleaseInput,
  ReserveInput,
  ReserveResult,
  SettleInput,
  SettleResult,
} from "./credits.facade.js";
import type { LotAllocation } from "./lot-allocation.js";
import type { PrismaTransaction } from "../common/prisma/prisma.service.js";
import type { $Enums } from "@prisma/client";

/** Rows a single `expireLots` pass looks at before yielding to the next batch. */
const EXPIRE_BATCH = 500;

/** Recorded on `credit_ledger.ref_type`; the ref id is always the job or lot id. */
const REF_TYPE_JOB = "job";
const REF_TYPE_LOT = "credit_lot";
const REF_TYPE_GRANT = "grant";

interface AccountRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly balanceTenths: number;
  readonly monthlyGrantTenths: number;
  readonly grantResetAt: Date | null;
}

/** What every mutating method hands back to the post-commit low-balance check. */
interface Outcome<T> {
  readonly result: T;
  readonly workspaceId: string;
  readonly beforeTenths: number;
  readonly afterTenths: number;
  readonly monthlyGrantTenths: number;
}

/** No balance change happened; the low-balance check is a guaranteed no-op. */
function unchanged<T>(result: T): Outcome<T> {
  return { result, workspaceId: "", beforeTenths: 0, afterTenths: 0, monthlyGrantTenths: 0 };
}

export interface ReverseInput {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly tenths: number;
  readonly reason: string;
}

export interface ReverseResult {
  /** The reversal lot(s) created — more than one when the original hold spanned
   *  more than one source lot, each portion inheriting its own lot's expiry. */
  readonly lotIds: readonly string[];
}

export interface ExpireLotsResult {
  readonly accountsAffected: number;
  readonly lotsExpired: number;
  readonly tenthsExpired: number;
}

export interface MonthlyGrantResetResult {
  readonly accountsReset: number;
  readonly tenthsGranted: number;
}

/**
 * The real `CreditsFacade` (D32, RR-09b P0-4): every balance move is one
 * conditional `UPDATE … RETURNING` plus a `credit_ledger` row in one transaction,
 * lots are consumed soonest-expiring first then FIFO, and settlement is
 * idempotent via a conditional status flip on `credit_holds`.
 *
 * Replaces A08's {@link NoopCreditsFacade} behind the same interface (CONTRACTS
 * §4) — nothing outside `apps/api/src/credits/**` changes.
 *
 * **`credit_holds.job_id` is unique — "one hold per job", not "one hold row ever
 * inserted per job".** A DLQ replay (`DlqService.replay`) reserves again for the
 * *same* job id after the original attempt's hold was released, so `reserve`
 * reuses that row (resets it back to `held` with the new amount) instead of
 * inserting a second one, which would violate the constraint. A second `reserve`
 * while a hold is still `held` is a caller bug (the live-job dedupe in
 * `JobsService.enqueue` and the claim-first CAS in `DlqService.replay` are what
 * make that unreachable in practice) and is rejected rather than silently
 * clobbering an open hold.
 *
 * **Every mutating method claims before it computes.** `settle` and `release`
 * both start with a conditional `UPDATE credit_holds … WHERE status = 'held'`
 * before touching a single lot or the account balance: if that claim matches zero
 * rows, nothing else in the method has run yet, so returning the recorded
 * settlement is a true no-op rather than a partially-applied one that has to be
 * unwound. Only once the claim succeeds does the method go on to move lots and
 * the account balance and correct the hold's final `settledTenths`/`status`.
 */
@Injectable()
export class LedgerCreditsFacade implements CreditsFacade {
  private readonly logger = new Logger(LedgerCreditsFacade.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lowBalance: CreditsLowBalanceNotifier,
  ) {}

  // ---------------------------------------------------------------------------
  // CreditsFacade (CONTRACTS §4)
  // ---------------------------------------------------------------------------

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    assertNonNegativeInteger(input.worstCaseTenths, "worstCaseTenths");

    return this.runAndNotify(
      this.transaction(async (tx) => {
        const account = await this.getOrCreateAccount(tx, input.workspaceId);

        const existing = await tx.creditHold.findUnique({ where: { jobId: input.jobId } });
        if (existing !== null && existing.status === "held") {
          throw new AppException(
            CREDIT_ERROR_CODES.holdNotFound,
            `Job ${input.jobId} already has an open hold; reserve() may not be called twice ` +
              "for a job whose hold is still live.",
            HttpStatus.CONFLICT,
            { jobId: input.jobId },
          );
        }

        const [row] = await tx.$queryRaw<{ balance_tenths: number }[]>`
          UPDATE credit_accounts
          SET balance_tenths = balance_tenths - ${input.worstCaseTenths}
          WHERE id = ${account.id} AND balance_tenths >= ${input.worstCaseTenths}
          RETURNING balance_tenths
        `;
        if (row === undefined) {
          const current = await tx.creditAccount.findUniqueOrThrow({
            where: { id: account.id },
            select: { balanceTenths: true },
          });
          throw new CreditsInsufficientError(
            Math.max(0, input.worstCaseTenths - current.balanceTenths),
            "Not enough credits for this job.",
            { workspaceId: input.workspaceId, requestedTenths: input.worstCaseTenths },
          );
        }

        const plan = allocateLots(await this.liveLots(tx, account.id), input.worstCaseTenths);
        if (!plan.fullyCovered) throw ledgerDrift(account.id, "reserve");
        await this.applyLotDeltas(tx, plan.allocations, -1);

        const holdId = existing?.id ?? ulid();
        if (existing === null) {
          await tx.creditHold.create({
            data: {
              id: holdId,
              accountId: account.id,
              jobId: input.jobId,
              amountTenths: input.worstCaseTenths,
              lotAllocations: plan.allocations as unknown as object,
              status: "held",
              settledTenths: 0,
            },
          });
        } else {
          await tx.creditHold.update({
            where: { id: existing.id },
            data: {
              amountTenths: input.worstCaseTenths,
              lotAllocations: plan.allocations as unknown as object,
              status: "held",
              settledTenths: 0,
              at: new Date(),
            },
          });
        }

        await this.writeLedger(tx, {
          accountId: account.id,
          delta: -input.worstCaseTenths,
          kind: "hold",
          refType: REF_TYPE_JOB,
          refId: input.jobId,
          balanceAfter: row.balance_tenths,
        });

        return {
          result: { holdId },
          workspaceId: account.workspaceId,
          beforeTenths: account.balanceTenths,
          afterTenths: row.balance_tenths,
          monthlyGrantTenths: account.monthlyGrantTenths,
        };
      }),
    );
  }

  async settle(input: SettleInput): Promise<SettleResult> {
    assertNonNegativeInteger(input.actualTenths, "actualTenths");

    return this.runAndNotify(
      this.transaction(async (tx) => {
        // Claim first: a conditional flip that only one caller can win, so a
        // replayed completion callback (THREAT-MODEL T8/T9) or a race with
        // `release` finds zero rows and does nothing else. `settledTenths` is
        // deliberately NOT set here — it stays at its current value (0, a held
        // hold's default) rather than jumping straight to `actualTenths`,
        // because `credit_holds_amounts_check` (`settled <= amount`) is
        // evaluated at the end of THIS statement, before the over-settlement
        // branch below has had a chance to raise `amountTenths` to match. Every
        // branch below writes the true final `settledTenths` itself, and the
        // over-settlement branch raises `amountTenths` in that SAME later
        // `UPDATE`, so the two fields only ever move together.
        const claim = await tx.creditHold.updateMany({
          where: { id: input.holdId, status: "held" },
          data: { status: "settled" },
        });

        if (claim.count === 0) {
          const hold = await tx.creditHold.findUnique({ where: { id: input.holdId } });
          // Unknown hold: at-least-once completion callbacks are a fact of life
          // (CONTRACTS §3); mirror NoopCreditsFacade and report back what we were
          // told rather than error on a hold this facade never created.
          if (hold === null) return unchanged({ settledTenths: input.actualTenths });
          return unchanged({ settledTenths: hold.settledTenths });
        }

        const hold = await tx.creditHold.findUniqueOrThrow({ where: { id: input.holdId } });
        const account = await tx.creditAccount.findUniqueOrThrow({
          where: { id: hold.accountId },
        });
        const held = hold.amountTenths;
        const allocations = hold.lotAllocations as unknown as LotAllocation[];

        if (input.actualTenths === held) {
          await tx.creditHold.update({
            where: { id: hold.id },
            data: { settledTenths: input.actualTenths },
          });
          await this.writeLedger(tx, {
            accountId: hold.accountId,
            delta: 0,
            kind: "settle",
            refType: REF_TYPE_JOB,
            refId: hold.jobId,
            balanceAfter: account.balanceTenths,
          });
          return {
            result: { settledTenths: input.actualTenths },
            workspaceId: account.workspaceId,
            beforeTenths: account.balanceTenths,
            afterTenths: account.balanceTenths,
            monthlyGrantTenths: account.monthlyGrantTenths,
          };
        }

        if (input.actualTenths < held) {
          const refund = held - input.actualTenths;
          const giveBack = giveBackLots(allocations, refund);
          await this.applyLotDeltas(tx, giveBack, 1);

          const [row] = await tx.$queryRaw<{ balance_tenths: number }[]>`
            UPDATE credit_accounts SET balance_tenths = balance_tenths + ${refund}
            WHERE id = ${hold.accountId}
            RETURNING balance_tenths
          `;
          const balanceAfter = row?.balance_tenths ?? account.balanceTenths + refund;
          await tx.creditHold.update({
            where: { id: hold.id },
            data: { settledTenths: input.actualTenths },
          });
          await this.writeLedger(tx, {
            accountId: hold.accountId,
            delta: refund,
            kind: "release",
            refType: REF_TYPE_JOB,
            refId: hold.jobId,
            balanceAfter,
          });
          return {
            result: { settledTenths: input.actualTenths },
            workspaceId: account.workspaceId,
            beforeTenths: account.balanceTenths,
            afterTenths: balanceAfter,
            monthlyGrantTenths: account.monthlyGrantTenths,
          };
        }

        // actualTenths > held: attempt a delta charge for the overage in the same
        // transaction. `credit_holds.job_id` is unique, so the delta is NOT a
        // second `credit_holds` row (that would collide with the hold this
        // settle just claimed) — it is an additional conditional debit folded
        // into this hold's own ledger trail, and `deltaHoldId` is the id of the
        // ledger row that recorded it, which is all CONTRACTS §4 promises
        // (`settledTenths`, `deltaHoldId?`) and enough to audit or dispute later.
        const delta = input.actualTenths - held;
        const [deltaRow] = await tx.$queryRaw<{ balance_tenths: number }[]>`
          UPDATE credit_accounts SET balance_tenths = balance_tenths - ${delta}
          WHERE id = ${hold.accountId} AND balance_tenths >= ${delta}
          RETURNING balance_tenths
        `;

        if (deltaRow === undefined) {
          // Insufficient for the overage: settle only what was already held and
          // mark the hold `partially_settled` (D32: "settle what is held and
          // return needs_credits"). The caller detects the shortfall from
          // `settledTenths < actualTenths` with no `deltaHoldId` — CONTRACTS §4's
          // frozen return shape carries no separate flag — and the zero/20%
          // notifier below fires on its own once the balance reflects it, so
          // there is no bespoke "needs_credits" notification to send from here.
          await tx.creditHold.update({
            where: { id: hold.id },
            data: { status: "partially_settled", settledTenths: held },
          });
          await this.writeLedger(tx, {
            accountId: hold.accountId,
            delta: 0,
            kind: "settle",
            refType: REF_TYPE_JOB,
            refId: hold.jobId,
            balanceAfter: account.balanceTenths,
          });
          this.logger.warn(
            { holdId: hold.id, jobId: hold.jobId, held, actualTenths: input.actualTenths },
            "settle: insufficient balance for the overage; needs_credits",
          );
          return {
            result: { settledTenths: held },
            workspaceId: account.workspaceId,
            beforeTenths: account.balanceTenths,
            afterTenths: account.balanceTenths,
            monthlyGrantTenths: account.monthlyGrantTenths,
          };
        }

        const deltaPlan = allocateLots(await this.liveLots(tx, hold.accountId), delta);
        if (!deltaPlan.fullyCovered) throw ledgerDrift(hold.accountId, "settle:delta");
        await this.applyLotDeltas(tx, deltaPlan.allocations, -1);

        const deltaLedgerId = ulid();
        await tx.creditLedger.create({
          data: {
            id: deltaLedgerId,
            accountId: hold.accountId,
            deltaTenths: -delta,
            kind: "settle",
            refType: REF_TYPE_JOB,
            refId: hold.jobId,
            balanceAfterTenths: deltaRow.balance_tenths,
          },
        });
        await tx.creditHold.update({
          where: { id: hold.id },
          data: {
            status: "settled",
            settledTenths: input.actualTenths,
            amountTenths: input.actualTenths,
            lotAllocations: mergeAllocations(
              allocations,
              deltaPlan.allocations,
            ) as unknown as object,
          },
        });

        return {
          result: { settledTenths: input.actualTenths, deltaHoldId: deltaLedgerId },
          workspaceId: account.workspaceId,
          beforeTenths: account.balanceTenths,
          afterTenths: deltaRow.balance_tenths,
          monthlyGrantTenths: account.monthlyGrantTenths,
        };
      }),
    );
  }

  async release(input: ReleaseInput): Promise<void> {
    await this.runAndNotify(
      this.transaction(async (tx) => {
        const claim = await tx.creditHold.updateMany({
          where: { id: input.holdId, status: "held" },
          data: { status: "released" },
        });
        if (claim.count === 0) return unchanged(undefined);

        const hold = await tx.creditHold.findUniqueOrThrow({ where: { id: input.holdId } });
        const allocations = hold.lotAllocations as unknown as LotAllocation[];
        await this.applyLotDeltas(tx, allocations, 1);

        const account = await tx.creditAccount.findUniqueOrThrow({
          where: { id: hold.accountId },
        });
        const [row] = await tx.$queryRaw<{ balance_tenths: number }[]>`
          UPDATE credit_accounts SET balance_tenths = balance_tenths + ${hold.amountTenths}
          WHERE id = ${hold.accountId}
          RETURNING balance_tenths
        `;
        const balanceAfter = row?.balance_tenths ?? account.balanceTenths + hold.amountTenths;
        await this.writeLedger(tx, {
          accountId: hold.accountId,
          delta: hold.amountTenths,
          kind: "release",
          refType: REF_TYPE_JOB,
          refId: hold.jobId,
          balanceAfter,
        });

        return {
          result: undefined,
          workspaceId: account.workspaceId,
          beforeTenths: account.balanceTenths,
          afterTenths: balanceAfter,
          monthlyGrantTenths: account.monthlyGrantTenths,
        };
      }),
    );
  }

  async grantLot(input: GrantLotInput): Promise<GrantLotResult> {
    assertNonNegativeInteger(input.tenths, "tenths");

    return this.runAndNotify(
      this.transaction(async (tx) => {
        const account = await this.getOrCreateAccount(tx, input.workspaceId);
        const lotId = ulid();
        await tx.creditLot.create({
          data: {
            id: lotId,
            accountId: account.id,
            source: input.source,
            grantedTenths: input.tenths,
            remainingTenths: input.tenths,
            expiresAt: input.expiresAt ?? null,
            // What was paid for this lot, when it came from money rather than a
            // grant or a referral bonus (B01's passes and top-ups). Optional on
            // the interface — a plan's monthly grant or a referral bonus has
            // none of these — and written straight onto the lot when given.
            ...(input.currency === undefined ? {} : { currency: input.currency }),
            ...(input.amountMinor === undefined ? {} : { amountMinor: input.amountMinor }),
            ...(input.invoiceId === undefined ? {} : { invoiceId: input.invoiceId }),
          },
        });

        const [row] = await tx.$queryRaw<{ balance_tenths: number }[]>`
          UPDATE credit_accounts SET balance_tenths = balance_tenths + ${input.tenths}
          WHERE id = ${account.id}
          RETURNING balance_tenths
        `;
        const balanceAfter = row?.balance_tenths ?? account.balanceTenths + input.tenths;

        await this.writeLedger(tx, {
          accountId: account.id,
          delta: input.tenths,
          kind: ledgerKindForSource(input.source),
          refType: REF_TYPE_GRANT,
          refId: input.refId,
          lotId,
          balanceAfter,
        });

        return {
          result: { lotId },
          workspaceId: account.workspaceId,
          beforeTenths: account.balanceTenths,
          afterTenths: balanceAfter,
          monthlyGrantTenths: account.monthlyGrantTenths,
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Beyond the frozen interface: reversal, expiry, monthly reset, reconcile
  // callers reach through the concrete class (admin/B13, B01 refunds, the
  // scheduled tasks in `credits/tasks/`) rather than through `CREDITS_FACADE`.
  // ---------------------------------------------------------------------------

  /**
   * Refund a settled job: a new lot inheriting the original lot's expiry, and a
   * `reversal` ledger row (D32). Called by admin refunds (B13) and B01's
   * payment-refund path — never by a producer, which is why it is not on
   * {@link CreditsFacade}.
   *
   * When the original hold drew from more than one lot, the reversal is split
   * proportionally so each portion inherits **its own** source lot's expiry
   * rather than picking one arbitrarily.
   */
  async reverse(input: ReverseInput): Promise<ReverseResult> {
    assertNonNegativeInteger(input.tenths, "tenths");

    return this.runAndNotify(
      this.transaction(async (tx) => {
        const account = await this.getOrCreateAccount(tx, input.workspaceId);
        const hold = await tx.creditHold.findUnique({ where: { jobId: input.jobId } });
        if (hold === null) {
          throw new AppException(
            CREDIT_ERROR_CODES.reversalSourceNotFound,
            `No credit hold on record for job ${input.jobId}; a reversal needs a prior job ` +
              "to inherit a lot expiry from.",
            HttpStatus.NOT_FOUND,
            { jobId: input.jobId },
          );
        }

        const allocations = hold.lotAllocations as unknown as LotAllocation[];
        const lots =
          allocations.length === 0
            ? []
            : await tx.creditLot.findMany({
                where: { id: { in: allocations.map((a) => a.lotId) } },
                select: { id: true, expiresAt: true },
              });
        const expiryByLot = new Map(lots.map((l) => [l.id, l.expiresAt]));

        const shares = allocations.length > 0 ? proportionalSplit(allocations, input.tenths) : [];
        const parts: { readonly tenths: number; readonly expiresAt: Date | null }[] =
          shares.length > 0
            ? shares
                .filter((s) => s.tenths > 0)
                .map((s) => ({ tenths: s.tenths, expiresAt: expiryByLot.get(s.lotId) ?? null }))
            : [{ tenths: input.tenths, expiresAt: null }];

        const [row] = await tx.$queryRaw<{ balance_tenths: number }[]>`
          UPDATE credit_accounts SET balance_tenths = balance_tenths + ${input.tenths}
          WHERE id = ${account.id}
          RETURNING balance_tenths
        `;
        const balanceAfter = row?.balance_tenths ?? account.balanceTenths + input.tenths;

        const lotIds: string[] = [];
        for (const part of parts) {
          if (part.tenths <= 0) continue;
          const newLotId = ulid();
          await tx.creditLot.create({
            data: {
              id: newLotId,
              accountId: account.id,
              source: "reversal",
              grantedTenths: part.tenths,
              remainingTenths: part.tenths,
              expiresAt: part.expiresAt,
            },
          });
          await this.writeLedger(tx, {
            accountId: account.id,
            delta: part.tenths,
            kind: "reversal",
            refType: REF_TYPE_JOB,
            refId: input.jobId,
            lotId: newLotId,
            balanceAfter,
          });
          lotIds.push(newLotId);
        }

        return {
          result: { lotIds },
          workspaceId: account.workspaceId,
          beforeTenths: account.balanceTenths,
          afterTenths: balanceAfter,
          monthlyGrantTenths: account.monthlyGrantTenths,
        };
      }),
    );
  }

  /**
   * Sweep lots whose `expiresAt` has passed, moving their remaining tenths to an
   * `expire` ledger entry (D32) and zeroing `remainingTenths`.
   *
   * Batched, and each lot expires in its **own** transaction: a sweep touching a
   * million lots must never hold one lock for the whole run, and a lot consumed
   * or already expired by a concurrent call is simply skipped, re-checked inside
   * that lot's own transaction rather than assumed from the outer scan.
   */
  async expireLots(now: Date = new Date()): Promise<ExpireLotsResult> {
    let lotsExpired = 0;
    let tenthsExpired = 0;
    const accountsTouched = new Set<string>();
    let cursor: string | undefined;

    for (;;) {
      const batch: { id: string }[] = await this.prisma.creditLot.findMany({
        where: { remainingTenths: { gt: 0 }, expiresAt: { lt: now } },
        orderBy: { id: "asc" },
        select: { id: true },
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        take: EXPIRE_BATCH,
      });
      if (batch.length === 0) break;

      for (const row of batch) {
        const expired = await this.expireOneLot(row.id, now);
        if (expired !== null) {
          lotsExpired += 1;
          tenthsExpired += expired.tenths;
          accountsTouched.add(expired.accountId);
        }
      }

      cursor = batch[batch.length - 1]?.id;
      if (batch.length < EXPIRE_BATCH) break;
    }

    return { accountsAffected: accountsTouched.size, lotsExpired, tenthsExpired };
  }

  /**
   * Grant the monthly allowance to every account whose `grantResetAt` has
   * passed, as a new `grant` lot expiring at the next period end, and advance
   * `grantResetAt` by one month.
   *
   * Deliberately does not know about plan-change proration ("upgrade: grant the
   * difference immediately; downgrade: at period end", 04 §Credits): that is a
   * reaction to a *subscription* event, which belongs to whichever module owns
   * subscriptions (B01), and it is exactly one `grantLot` call away — B01 calls
   * `grantLot({source:"grant", tenths: difference, expiresAt: periodEnd, refId:
   * subscriptionId})` directly. This method is only the recurring,
   * subscription-agnostic anniversary tick.
   */
  async resetMonthlyGrants(now: Date = new Date()): Promise<MonthlyGrantResetResult> {
    const due = await this.prisma.creditAccount.findMany({
      where: { grantResetAt: { lte: now }, monthlyGrantTenths: { gt: 0 } },
      select: { id: true },
    });

    let accountsReset = 0;
    let tenthsGranted = 0;
    for (const { id: accountId } of due) {
      const granted = await this.resetOneAccountGrant(accountId, now);
      if (granted !== null) {
        accountsReset += 1;
        tenthsGranted += granted;
      }
    }
    return { accountsReset, tenthsGranted };
  }

  /**
   * One account's grant reset, atomically: advance `grantResetAt` — conditional
   * on it still being due, so a scheduler tick that fires twice (its documented
   * at-least-once contract) grants once, not twice — create the grant lot,
   * credit the balance and write the ledger row, all in one transaction.
   */
  private async resetOneAccountGrant(accountId: string, now: Date): Promise<number | null> {
    const outcome = await this.transaction(async (tx) => {
      const account = await tx.creditAccount.findUnique({ where: { id: accountId } });
      if (
        account === null ||
        account.grantResetAt === null ||
        account.grantResetAt > now ||
        account.monthlyGrantTenths <= 0
      ) {
        return null;
      }

      const claim = await tx.creditAccount.updateMany({
        where: { id: accountId, grantResetAt: account.grantResetAt },
        data: { grantResetAt: addMonths(now, 1) },
      });
      if (claim.count === 0) return null; // a concurrent tick already claimed it

      const periodEnd = addMonths(now, 1);
      const lotId = ulid();
      const tenths = account.monthlyGrantTenths;
      await tx.creditLot.create({
        data: {
          id: lotId,
          accountId,
          source: "grant",
          grantedTenths: tenths,
          remainingTenths: tenths,
          expiresAt: periodEnd,
        },
      });

      const [row] = await tx.$queryRaw<{ balance_tenths: number }[]>`
        UPDATE credit_accounts SET balance_tenths = balance_tenths + ${tenths}
        WHERE id = ${accountId}
        RETURNING balance_tenths
      `;
      const balanceAfter = row?.balance_tenths ?? account.balanceTenths + tenths;
      await this.writeLedger(tx, {
        accountId,
        delta: tenths,
        kind: "grant",
        refType: REF_TYPE_GRANT,
        refId: "monthly-reset",
        lotId,
        balanceAfter,
      });

      return {
        result: tenths,
        workspaceId: account.workspaceId,
        beforeTenths: account.balanceTenths,
        afterTenths: balanceAfter,
        monthlyGrantTenths: account.monthlyGrantTenths,
      };
    });
    if (outcome === null) return null;
    return this.runAndNotify(Promise.resolve(outcome));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async getOrCreateAccount(
    tx: PrismaTransaction,
    workspaceId: string,
  ): Promise<AccountRow> {
    // Every workspace is supposed to have exactly one `credit_accounts` row
    // (06 §ERD, `WORKSPACE ||--|| CREDIT_ACCOUNT`), but nothing on the
    // workspace-creation path provisions it yet (only `prisma/seed.ts` does, for
    // the demo workspace) — so the ledger creates one lazily, at zero balance,
    // the first time a workspace's credits are touched. Run inside the caller's
    // own transaction (not `this.prisma`) so a first-touch reserve that then
    // fails to find enough balance rolls the empty account back out too, and the
    // upsert is what makes two concurrent first-touches for the same workspace
    // safe without a separate existence check.
    const account = await tx.creditAccount.upsert({
      where: { workspaceId },
      create: {
        id: ulid(),
        workspaceId,
        balanceTenths: 0,
        monthlyGrantTenths: 0,
        grantResetAt: null,
      },
      update: {},
    });
    return account;
  }

  private async liveLots(
    tx: PrismaTransaction,
    accountId: string,
  ): Promise<{ id: string; remainingTenths: number; expiresAt: Date | null; createdAt: Date }[]> {
    return tx.creditLot.findMany({
      where: { accountId, remainingTenths: { gt: 0 } },
      select: { id: true, remainingTenths: true, expiresAt: true, createdAt: true },
      orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
    });
  }

  private async applyLotDeltas(
    tx: PrismaTransaction,
    allocations: readonly LotAllocation[],
    sign: 1 | -1,
  ): Promise<void> {
    for (const allocation of allocations) {
      if (allocation.tenths === 0) continue;
      await tx.creditLot.update({
        where: { id: allocation.lotId },
        data: {
          remainingTenths:
            sign === 1 ? { increment: allocation.tenths } : { decrement: allocation.tenths },
        },
      });
    }
  }

  private async writeLedger(
    tx: PrismaTransaction,
    input: {
      readonly accountId: string;
      readonly delta: number;
      readonly kind: $Enums.CreditLedgerKind;
      readonly refType: string;
      readonly refId?: string;
      readonly lotId?: string;
      readonly balanceAfter: number;
    },
  ): Promise<void> {
    await tx.creditLedger.create({
      data: {
        id: ulid(),
        accountId: input.accountId,
        deltaTenths: input.delta,
        kind: input.kind,
        refType: input.refType,
        refId: input.refId ?? null,
        lotId: input.lotId ?? null,
        balanceAfterTenths: input.balanceAfter,
      },
    });
  }

  private async expireOneLot(
    lotId: string,
    now: Date,
  ): Promise<{ accountId: string; tenths: number } | null> {
    return this.transaction(async (tx) => {
      // `SELECT … FOR UPDATE`, not `findUnique`: a plain read does not lock the
      // row, and `remainingTenths` is about to be read and then overwritten with
      // a *literal* 0 rather than a relative decrement — `UPDATE …
      // RETURNING remaining_tenths` would report the POST-update value (always
      // 0), not what was actually there to move off the account. Locking first
      // makes the read-then-write atomic against a concurrent `reserve`/`settle`
      // that is simultaneously drawing this same lot down by a relative amount:
      // whichever transaction reaches this lot first holds it until it commits,
      // and the other proceeds only against the now-current row.
      const [locked] = await tx.$queryRaw<
        { account_id: string; remaining_tenths: number; expires_at: Date | null }[]
      >`
        SELECT account_id, remaining_tenths, expires_at
        FROM credit_lots WHERE id = ${lotId}
        FOR UPDATE
      `;
      if (
        locked === undefined ||
        locked.remaining_tenths <= 0 ||
        locked.expires_at === null ||
        locked.expires_at >= now
      ) {
        return null;
      }

      const tenths = locked.remaining_tenths;
      await tx.creditLot.update({ where: { id: lotId }, data: { remainingTenths: 0 } });

      const [row] = await tx.$queryRaw<{ balance_tenths: number }[]>`
        UPDATE credit_accounts SET balance_tenths = balance_tenths - ${tenths}
        WHERE id = ${locked.account_id}
        RETURNING balance_tenths
      `;
      await this.writeLedger(tx, {
        accountId: locked.account_id,
        delta: -tenths,
        kind: "expire",
        refType: REF_TYPE_LOT,
        refId: lotId,
        lotId,
        balanceAfter: row?.balance_tenths ?? 0,
      });
      return { accountId: locked.account_id, tenths };
    });
  }

  /** Await the transaction, then fire the low-balance check post-commit. */
  private async runAndNotify<T>(pending: Promise<Outcome<T>>): Promise<T> {
    const outcome = await pending;
    if (outcome.workspaceId !== "") {
      await this.lowBalance.checkThreshold({
        workspaceId: outcome.workspaceId,
        beforeTenths: outcome.beforeTenths,
        afterTenths: outcome.afterTenths,
        monthlyGrantTenths: outcome.monthlyGrantTenths,
      });
    }
    return outcome.result;
  }

  /**
   * `this.prisma.withTransaction`, retried on the one class of error a correct
   * caller cannot avoid by writing better code: Postgres detecting a deadlock
   * (two transactions each waiting on a lock the other holds — the account row
   * and a lot row can legitimately be touched in different orders by different
   * methods here, e.g. `reserve` locks the account before its lots while
   * `expireLots` locks a lot before the account it belongs to) or a
   * serialization failure. Prisma surfaces both as `P2034`
   * ("Transaction failed due to a write conflict or a deadlock. Please retry
   * your transaction"). Retrying is safe because a deadlock aborts the whole
   * transaction — nothing partial to clean up — and the retried attempt re-reads
   * every row from scratch.
   */
  private async transaction<T>(
    fn: (tx: PrismaTransaction) => Promise<T>,
    options?: Parameters<PrismaService["withTransaction"]>[1],
  ): Promise<T> {
    // `maxWaitMs` is how long a call queues for a free pool connection before
    // Prisma gives up with "Unable to start a transaction in the given time" —
    // NOT a deadlock, just every connection busy for a moment under real
    // concurrency (THREAT-MODEL T9's property test runs 50 workers against one
    // account on purpose). The default 5 s is sized for ordinary request
    // traffic; a ledger op is a handful of short statements, so it is cheaper
    // and more correct to wait longer for a connection than to fail a
    // legitimate request outright. `timeoutMs` is raised to match — the ceiling
    // on how long the transaction itself may stay open once it has one.
    const resolved = { timeoutMs: 20_000, maxWaitMs: 20_000, ...options };
    const attempts = 6;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.prisma.withTransaction(fn, resolved);
      } catch (error) {
        lastError = error;
        if (!isRetryableTransactionError(error) || attempt === attempts) throw error;
        await sleep(Math.floor(Math.random() * 20 * attempt) + 5);
      }
    }
    throw lastError;
  }
}

/**
 * A Postgres deadlock or serialization failure, worth retrying the whole
 * transaction for.
 *
 * Three different shapes show up depending on WHERE Prisma notices it:
 *
 * - `P2034` is Prisma's own translation, raised when its interactive-
 *   transaction machinery itself detects the conflict ("Transaction failed
 *   due to a write conflict or a deadlock. Please retry your transaction").
 * - The raw Postgres SQLSTATE (`40P01` deadlock_detected, `40001`
 *   serialization_failure) comes through as `.code` UNTRANSLATED on a
 *   `PrismaClientKnownRequestError` from a `$queryRaw` inside that
 *   transaction — exactly where this facade's conditional `UPDATE …
 *   RETURNING` statements run.
 * - The SAME failure from an ordinary `tx.<model>.update()` (not `$queryRaw`)
 *   instead surfaces as a `PrismaClientUnknownRequestError`, which carries NO
 *   structured `.code` at all — only a `.message` with the connector's raw
 *   error text embedded in it. That is the case `applyLotDeltas`'s plain
 *   Prisma calls hit, so the message is checked too.
 *
 * All three mean the same thing: the transaction was aborted with nothing
 * partial left behind, so retrying it from scratch is safe.
 */
function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "P2034" || code === "40P01" || code === "40001") return true;
  return /deadlock detected|could not serialize access|"40P01"|"40001"|unable to start a transaction/i.test(
    error.message,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ledgerKindForSource(source: CreditLotSource): $Enums.CreditLedgerKind {
  switch (source) {
    case "grant":
      return "grant";
    case "topup":
    case "pass":
      return "purchase";
    case "referral":
      return "referral_bonus";
    case "adjust":
      return "adjust";
    case "reversal":
      return "reversal";
  }
}

function ledgerDrift(accountId: string, where: string): AppException {
  // Should never happen while invariant 1 holds (06 §Invariants): the account's
  // cached balance and the sum of its lots' remaining tenths only ever move
  // together, in the same transaction. If the lots on hand cannot cover an
  // amount the account's own balance said was available, something upstream
  // wrote the two out of step — surfaced loudly rather than silently
  // over-allocating.
  return new AppException(
    ERROR_CODES.internal,
    "Credit ledger drift: the account balance and its lots disagree.",
    HttpStatus.INTERNAL_SERVER_ERROR,
    { accountId, where },
  );
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of tenths, got ${value}`);
  }
}
