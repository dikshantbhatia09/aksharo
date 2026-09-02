/**
 * The real ledger against a real Postgres (D32, RR-09b P0-4, brief acceptance
 * criterion 1): lot consumption order, expiry, delta holds, idempotent settle,
 * reversal expiry inheritance, reconcile and the orphaned-holds runbook query.
 *
 * Drives `LedgerCreditsFacade`/`CreditReconcileService`/
 * `CreditOrphanedHoldsService` directly rather than through HTTP — these are
 * the ledger's own invariants, and every conditional `UPDATE … RETURNING`,
 * `CHECK` constraint and transaction needs a real database, but none of it
 * needs auth, routing or the notify queue. `NotifyService` is stubbed (this
 * suite is not about the low-credit notifier) and Redis is not needed at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { CreditOrphanedHoldsService } from "../src/credits/credit-orphaned-holds.service.js";
import { CreditReconcileService } from "../src/credits/credit-reconcile.service.js";
import { CreditsLowBalanceNotifier } from "../src/credits/credits-low-balance.notifier.js";
import { CreditsInsufficientError } from "../src/credits/credits.facade.js";
import { LedgerCreditsFacade } from "../src/credits/ledger-credits.facade.js";

import type { TestDatabase } from "./db-harness.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { NotifyService } from "../src/notify/notify.service.js";
import type { PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();
if (!available) {
  console.warn(`[credits-ledger.e2e] SKIPPED - ${skipReason}`);
}

let db: TestDatabase;
let prisma: PrismaClient;
let credits: LedgerCreditsFacade;
let reconcile: CreditReconcileService;
let orphanedHolds: CreditOrphanedHoldsService;
let seq = 0;

describe.skipIf(!available)("LedgerCreditsFacade (e2e)", () => {
  beforeAll(async () => {
    db = (await createTestDatabase())!;
    if (db === null) throw new Error(`test database unavailable: ${skipReason}`);
    prisma = db.prisma;

    const prismaService = Object.assign(prisma, {
      withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => prisma.$transaction(fn),
    }) as unknown as PrismaService;

    const stubNotify = {
      enqueue: async () => ({ idempotencyKey: "stub", enqueued: false }),
    } as unknown as NotifyService;

    const notifier = new CreditsLowBalanceNotifier(prismaService, stubNotify);
    credits = new LedgerCreditsFacade(prismaService, notifier);
    reconcile = new CreditReconcileService(prismaService);
    orphanedHolds = new CreditOrphanedHoldsService(prismaService, credits);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  function id(label: string): string {
    seq += 1;
    return `01J${label.slice(0, 4).toUpperCase().padEnd(4, "0")}${String(seq).padStart(19, "0")}`;
  }

  /** A fresh workspace (and its owner), so every test starts isolated. */
  async function newWorkspace(): Promise<string> {
    const userId = id("usr");
    const workspaceId = id("wsp");
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId.toLowerCase(),
        name: "Test workspace",
        ownerId: userId,
        billingCountry: "IN",
      },
    });
    return workspaceId;
  }

  /** A minimal `jobs` row: `credit_holds.job_id` is a real foreign key. */
  async function newJob(workspaceId: string): Promise<string> {
    const jobId = id("job");
    await prisma.job.create({
      data: { id: jobId, workspaceId, type: "ai.transcribe", jobKey: `test:${jobId}` },
    });
    return jobId;
  }

  async function accountFor(workspaceId: string) {
    return prisma.creditAccount.findUniqueOrThrow({ where: { workspaceId } });
  }

  async function lotsFor(workspaceId: string) {
    const account = await accountFor(workspaceId);
    return prisma.creditLot.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "asc" },
    });
  }

  async function ledgerFor(workspaceId: string) {
    const account = await accountFor(workspaceId);
    return prisma.creditLedger.findMany({
      where: { accountId: account.id },
      orderBy: { id: "asc" },
    });
  }

  // -------------------------------------------------------------------------
  // reserve
  // -------------------------------------------------------------------------

  describe("reserve", () => {
    it("holds credits, decrements the balance and writes a hold ledger row", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);

      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 40,
        reason: "t",
      });

      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(60);

      const hold = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
      expect(hold.status).toBe("held");
      expect(hold.amountTenths).toBe(40);
      expect(hold.settledTenths).toBe(0);

      const ledger = await ledgerFor(workspaceId);
      const holdRow = ledger.find((row) => row.kind === "hold");
      expect(holdRow?.deltaTenths).toBe(-40);
      expect(holdRow?.balanceAfterTenths).toBe(60);
    });

    it("fails with the shortfall when the balance cannot cover it", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 10, reason: "fixture" });
      const jobId = await newJob(workspaceId);

      const error = await credits
        .reserve({ workspaceId, jobId, worstCaseTenths: 30, reason: "t" })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CreditsInsufficientError);
      expect((error as CreditsInsufficientError).shortfallTenths).toBe(20);

      // Nothing moved: the balance and the lots are untouched.
      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(10);
    });

    it("draws lots soonest-expiring first, then FIFO", async () => {
      const workspaceId = await newWorkspace();
      const now = Date.now();
      // Grant order deliberately scrambled relative to expiry order.
      await credits.grantLot({
        workspaceId,
        source: "grant",
        tenths: 20,
        expiresAt: new Date(now + 30 * 86_400_000),
        reason: "later",
      });
      await credits.grantLot({ workspaceId, source: "topup", tenths: 20, reason: "no expiry" });
      await credits.grantLot({
        workspaceId,
        source: "grant",
        tenths: 20,
        expiresAt: new Date(now + 1 * 86_400_000),
        reason: "soon",
      });

      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 45,
        reason: "t",
      });

      const hold = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
      const allocations = hold.lotAllocations as { lotId: string; tenths: number }[];
      const lots = await lotsFor(workspaceId);
      const bySource = (source: string) => lots.find((l) => l.source === source && l.createdAt);

      // The "soon" lot (20) drains fully first, then the "later" lot (20) fully,
      // then 5 off the no-expiry lot.
      const soonLot = lots.find(
        (l) =>
          l.grantedTenths === 20 &&
          l.expiresAt !== null &&
          l.expiresAt < new Date(now + 2 * 86_400_000),
      );
      const laterLot = lots.find(
        (l) =>
          l.grantedTenths === 20 &&
          l.expiresAt !== null &&
          l.expiresAt >= new Date(now + 2 * 86_400_000),
      );
      const openLot = lots.find((l) => l.expiresAt === null);
      expect(soonLot).toBeDefined();
      expect(laterLot).toBeDefined();
      expect(openLot).toBeDefined();

      expect(allocations.find((a) => a.lotId === soonLot?.id)?.tenths).toBe(20);
      expect(allocations.find((a) => a.lotId === laterLot?.id)?.tenths).toBe(20);
      expect(allocations.find((a) => a.lotId === openLot?.id)?.tenths).toBe(5);
      void bySource;
    });

    it("rejects a second reserve while a hold is still live", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);
      await credits.reserve({ workspaceId, jobId, worstCaseTenths: 10, reason: "t" });

      await expect(
        credits.reserve({ workspaceId, jobId, worstCaseTenths: 10, reason: "t" }),
      ).rejects.toMatchObject({ code: "credits/hold_not_found" });
    });

    it("a DLQ-style replay reuses the same hold row after a release", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);

      const first = await credits.reserve({ workspaceId, jobId, worstCaseTenths: 10, reason: "t" });
      await credits.release({ holdId: first.holdId });

      const second = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 25,
        reason: "t",
      });
      expect(second.holdId).toBe(first.holdId); // same row, reused

      const hold = await prisma.creditHold.findUniqueOrThrow({ where: { id: second.holdId } });
      expect(hold.status).toBe("held");
      expect(hold.amountTenths).toBe(25);

      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(75);
    });
  });

  // -------------------------------------------------------------------------
  // settle
  // -------------------------------------------------------------------------

  describe("settle", () => {
    it("is a true no-op the second time (idempotent, THREAT-MODEL T8/T9)", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 40,
        reason: "t",
      });

      await expect(credits.settle({ holdId, actualTenths: 25 })).resolves.toEqual({
        settledTenths: 25,
      });
      const afterFirst = await accountFor(workspaceId);
      expect(afterFirst.balanceTenths).toBe(75); // 100 - 40 + (40-25) refund

      // A replayed completion callback: reports the SAME recorded settlement and
      // moves no more money.
      await expect(credits.settle({ holdId, actualTenths: 25 })).resolves.toEqual({
        settledTenths: 25,
      });
      await expect(credits.settle({ holdId, actualTenths: 999 })).resolves.toEqual({
        settledTenths: 25,
      });
      const afterReplay = await accountFor(workspaceId);
      expect(afterReplay.balanceTenths).toBe(75);
    });

    it("settles exactly the hold with no lot movement beyond the reserve", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 40,
        reason: "t",
      });

      await credits.settle({ holdId, actualTenths: 40 });

      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(60);
      const hold = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
      expect(hold.status).toBe("settled");
      expect(hold.settledTenths).toBe(40);
    });

    it("releases the unused difference back to the same lots when actual < held", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 40,
        reason: "t",
      });

      await credits.settle({ holdId, actualTenths: 15 });

      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(85); // 100 - 40 + 25
      const lots = await lotsFor(workspaceId);
      expect(lots[0]?.remainingTenths).toBe(85);
    });

    it("raises a delta charge when actual > held and enough balance exists", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 20,
        reason: "t",
      });

      const result = await credits.settle({ holdId, actualTenths: 55 });
      expect(result.settledTenths).toBe(55);
      expect(result.deltaHoldId).toBeDefined();

      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(45); // 100 - 55

      const hold = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
      expect(hold.status).toBe("settled");
      expect(hold.settledTenths).toBe(55);
      expect(hold.amountTenths).toBe(55); // raised to match, so settled <= amount

      const ledger = await ledgerFor(workspaceId);
      const settleRows = ledger.filter((row) => row.kind === "settle");
      expect(settleRows).toHaveLength(1);
      expect(settleRows[0]?.deltaTenths).toBe(-35); // the delta (55-20)
    });

    it("settles only the held amount and needs_credits when the overage cannot be covered", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 30, reason: "fixture" });
      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 20,
        reason: "t",
      });
      // Balance is now 10 — not enough to cover a further 15 (35 - 20).

      const result = await credits.settle({ holdId, actualTenths: 35 });

      // CONTRACTS §4's frozen shape carries no separate flag: the caller detects
      // needs_credits from settledTenths < actualTenths with no deltaHoldId.
      expect(result.settledTenths).toBe(20);
      expect(result.deltaHoldId).toBeUndefined();
      expect(result.settledTenths).toBeLessThan(35);

      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(10); // unchanged by the failed delta attempt

      const hold = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
      expect(hold.status).toBe("partially_settled");
      expect(hold.settledTenths).toBe(20);
    });

    it("treats an unknown hold as a no-op, mirroring the no-op facade", async () => {
      await expect(
        credits.settle({ holdId: "01JUNKNOWN00000000000000", actualTenths: 7 }),
      ).resolves.toEqual({ settledTenths: 7 });
    });
  });

  // -------------------------------------------------------------------------
  // release
  // -------------------------------------------------------------------------

  describe("release", () => {
    it("returns the hold to the balance untouched and is idempotent", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 40,
        reason: "t",
      });

      await credits.release({ holdId });
      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(100);

      // Idempotent: releasing again changes nothing.
      await credits.release({ holdId });
      const again = await accountFor(workspaceId);
      expect(again.balanceTenths).toBe(100);

      // Never reopens a released hold: nothing was ever settled on it, so a
      // settle attempt afterward reports 0 (the hold's recorded settledTenths)
      // and moves no money.
      await expect(credits.settle({ holdId, actualTenths: 10 })).resolves.toEqual({
        settledTenths: 0,
      });
      const afterSettleAttempt = await accountFor(workspaceId);
      expect(afterSettleAttempt.balanceTenths).toBe(100);
      const holdAfter = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
      expect(holdAfter.status).toBe("released");
    });

    it("ignores an unknown hold", async () => {
      await expect(
        credits.release({ holdId: "01JUNKNOWN00000000000001" }),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // grantLot
  // -------------------------------------------------------------------------

  describe("grantLot", () => {
    it("creates every workspace's first credit account lazily, at zero balance", async () => {
      const workspaceId = await newWorkspace();
      const { lotId } = await credits.grantLot({
        workspaceId,
        source: "referral",
        tenths: 30,
        reason: "give-30-get-30",
      });

      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(30);
      const lot = await prisma.creditLot.findUniqueOrThrow({ where: { id: lotId } });
      expect(lot.source).toBe("referral");
      expect(lot.expiresAt).toBeNull();

      const ledger = await ledgerFor(workspaceId);
      expect(ledger[0]?.kind).toBe("referral_bonus");
    });
  });

  // -------------------------------------------------------------------------
  // reverse
  // -------------------------------------------------------------------------

  describe("reverse", () => {
    it("creates a new lot inheriting the original lot's expiry", async () => {
      const workspaceId = await newWorkspace();
      const expiresAt = new Date(Date.now() + 10 * 86_400_000);
      await credits.grantLot({
        workspaceId,
        source: "grant",
        tenths: 50,
        expiresAt,
        reason: "grant",
      });
      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 30,
        reason: "t",
      });
      await credits.settle({ holdId, actualTenths: 30 });

      const { lotIds } = await credits.reverse({
        workspaceId,
        jobId,
        tenths: 30,
        reason: "bad artefact",
      });

      expect(lotIds).toHaveLength(1);
      const reversalLot = await prisma.creditLot.findUniqueOrThrow({ where: { id: lotIds[0] } });
      expect(reversalLot.source).toBe("reversal");
      expect(reversalLot.expiresAt?.getTime()).toBe(expiresAt.getTime());
      expect(reversalLot.remainingTenths).toBe(30);

      const account = await accountFor(workspaceId);
      // 50 granted - 30 held (exact settle moves nothing further) + 30 reversed.
      expect(account.balanceTenths).toBe(50);

      const ledger = await ledgerFor(workspaceId);
      expect(ledger.find((row) => row.kind === "reversal")?.lotId).toBe(lotIds[0]);
    });

    it("splits proportionally across every lot a hold drew from, each keeping its own expiry", async () => {
      const workspaceId = await newWorkspace();
      const soonExpiry = new Date(Date.now() + 1 * 86_400_000);
      const laterExpiry = new Date(Date.now() + 30 * 86_400_000);
      await credits.grantLot({
        workspaceId,
        source: "grant",
        tenths: 10,
        expiresAt: soonExpiry,
        reason: "a",
      });
      await credits.grantLot({
        workspaceId,
        source: "grant",
        tenths: 10,
        expiresAt: laterExpiry,
        reason: "b",
      });

      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 20,
        reason: "t",
      });
      await credits.settle({ holdId, actualTenths: 20 });

      const { lotIds } = await credits.reverse({
        workspaceId,
        jobId,
        tenths: 20,
        reason: "refund",
      });
      expect(lotIds).toHaveLength(2);

      const reversalLots = await prisma.creditLot.findMany({ where: { id: { in: [...lotIds] } } });
      const expiries = reversalLots.map((l) => l.expiresAt?.getTime()).sort();
      expect(expiries).toEqual([soonExpiry.getTime(), laterExpiry.getTime()].sort());
      const total = reversalLots.reduce((sum, l) => sum + l.grantedTenths, 0);
      expect(total).toBe(20);
    });

    it("throws credits/reversal_source_not_found when the job never held credits", async () => {
      const workspaceId = await newWorkspace();
      const jobId = await newJob(workspaceId);
      await expect(
        credits.reverse({ workspaceId, jobId, tenths: 10, reason: "no hold" }),
      ).rejects.toMatchObject({ code: "credits/reversal_source_not_found" });
    });
  });

  // -------------------------------------------------------------------------
  // revokeLot (B02b)
  // -------------------------------------------------------------------------

  describe("revokeLot", () => {
    it("takes tenths off the named lot and the account balance", async () => {
      const workspaceId = await newWorkspace();
      const { lotId } = await credits.grantLot({
        workspaceId,
        source: "topup",
        tenths: 100,
        reason: "top-up",
      });

      const result = await credits.revokeLot({
        lotId,
        tenths: 40,
        reason: "payment refund",
        refundId: "01JREFUNDA0000000000000000",
      });

      expect(result).toEqual({ revokedTenths: 40, shortfallTenths: 0 });
      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(60);
      const lot = await prisma.creditLot.findUniqueOrThrow({ where: { id: lotId } });
      expect(lot.remainingTenths).toBe(60);

      const ledger = await ledgerFor(workspaceId);
      const revokeRow = ledger.find((row) => row.kind === "revoke");
      expect(revokeRow).toMatchObject({ deltaTenths: -40, lotId, refId: "01JREFUNDA0000000000000000" });
    });

    it("revokes everything remaining when tenths is omitted", async () => {
      const workspaceId = await newWorkspace();
      const { lotId } = await credits.grantLot({
        workspaceId,
        source: "grant",
        tenths: 75,
        reason: "grant",
      });

      const result = await credits.revokeLot({ lotId, reason: "refund", refundId: "01JREFUNDB0000000000000000" });
      expect(result).toEqual({ revokedTenths: 75, shortfallTenths: 0 });
      expect((await accountFor(workspaceId)).balanceTenths).toBe(0);
    });

    it("caps at what the lot has left and reports the rest as a shortfall", async () => {
      const workspaceId = await newWorkspace();
      const { lotId } = await credits.grantLot({
        workspaceId,
        source: "topup",
        tenths: 100,
        reason: "top-up",
      });
      const jobId = await newJob(workspaceId);
      // Spend 60 of the 100, so only 40 remains on the lot.
      const { holdId } = await credits.reserve({ workspaceId, jobId, worstCaseTenths: 60, reason: "t" });
      await credits.settle({ holdId, actualTenths: 60 });

      const result = await credits.revokeLot({
        lotId,
        tenths: 100, // asks for the original amount, but only 40 is left
        reason: "full refund",
        refundId: "01JREFUNDC0000000000000000",
      });

      expect(result).toEqual({ revokedTenths: 40, shortfallTenths: 60 });
      expect((await accountFor(workspaceId)).balanceTenths).toBe(0);
      const lot = await prisma.creditLot.findUniqueOrThrow({ where: { id: lotId } });
      expect(lot.remainingTenths).toBe(0);
    });

    it("is idempotent per refundId — a retry reports the same result and moves no more money", async () => {
      const workspaceId = await newWorkspace();
      const { lotId } = await credits.grantLot({
        workspaceId,
        source: "topup",
        tenths: 100,
        reason: "top-up",
      });

      const first = await credits.revokeLot({
        lotId,
        tenths: 30,
        reason: "refund",
        refundId: "01JREFUNDD0000000000000000",
      });
      const second = await credits.revokeLot({
        lotId,
        tenths: 30,
        reason: "refund (retried)",
        refundId: "01JREFUNDD0000000000000000",
      });

      expect(second).toEqual(first);
      expect((await accountFor(workspaceId)).balanceTenths).toBe(70); // not 40
      const ledger = await ledgerFor(workspaceId);
      expect(ledger.filter((row) => row.kind === "revoke")).toHaveLength(1);
    });

    it("throws credits/lot_not_found for an unknown lot", async () => {
      await expect(
        credits.revokeLot({
          lotId: "01JUNKNOWNLOT0000000000000",
          tenths: 10,
          reason: "refund",
          refundId: "01JREFUNDE0000000000000000",
        }),
      ).rejects.toMatchObject({ code: "credits/lot_not_found" });
    });

    it("never takes the lot or the balance below zero", async () => {
      const workspaceId = await newWorkspace();
      const { lotId } = await credits.grantLot({
        workspaceId,
        source: "topup",
        tenths: 10,
        reason: "top-up",
      });

      const result = await credits.revokeLot({
        lotId,
        tenths: 1_000, // far more than was ever granted
        reason: "over-ask",
        refundId: "01JREFUNDF0000000000000000",
      });

      expect(result).toEqual({ revokedTenths: 10, shortfallTenths: 990 });
      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(0);
      expect(account.balanceTenths).toBeGreaterThanOrEqual(0);
      const lot = await prisma.creditLot.findUniqueOrThrow({ where: { id: lotId } });
      expect(lot.remainingTenths).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // expireLots
  // -------------------------------------------------------------------------

  describe("expireLots", () => {
    it("moves remaining tenths to an expire ledger entry and zeroes the lot", async () => {
      const workspaceId = await newWorkspace();
      const past = new Date(Date.now() - 1000);
      await credits.grantLot({
        workspaceId,
        source: "grant",
        tenths: 40,
        expiresAt: past,
        reason: "old grant",
      });
      await credits.grantLot({ workspaceId, source: "topup", tenths: 10, reason: "never expires" });

      const result = await credits.expireLots(new Date());
      expect(result.lotsExpired).toBe(1);
      expect(result.tenthsExpired).toBe(40);

      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(10);

      const lots = await lotsFor(workspaceId);
      const expired = lots.find((l) => l.expiresAt !== null);
      expect(expired?.remainingTenths).toBe(0);

      const ledger = await ledgerFor(workspaceId);
      expect(ledger.find((row) => row.kind === "expire")?.deltaTenths).toBe(-40);
    });

    it("leaves a not-yet-expired lot untouched", async () => {
      const workspaceId = await newWorkspace();
      const future = new Date(Date.now() + 86_400_000);
      await credits.grantLot({
        workspaceId,
        source: "grant",
        tenths: 40,
        expiresAt: future,
        reason: "grant",
      });

      const result = await credits.expireLots(new Date());
      expect(result.lotsExpired).toBe(0);
      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(40);
    });
  });

  // -------------------------------------------------------------------------
  // resetMonthlyGrants
  // -------------------------------------------------------------------------

  describe("resetMonthlyGrants", () => {
    it("grants the monthly allowance and advances grantResetAt", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({
        workspaceId,
        source: "topup",
        tenths: 0,
        reason: "create the account",
      });
      const account = await accountFor(workspaceId);
      await prisma.creditAccount.update({
        where: { id: account.id },
        data: { monthlyGrantTenths: 200, grantResetAt: new Date(Date.now() - 1000) },
      });

      const result = await credits.resetMonthlyGrants(new Date());
      expect(result.accountsReset).toBe(1);
      expect(result.tenthsGranted).toBe(200);

      const after = await accountFor(workspaceId);
      expect(after.balanceTenths).toBe(200);
      expect(after.grantResetAt?.getTime()).toBeGreaterThan(Date.now());
    });

    it("is safe to run twice (at-least-once scheduler contract)", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({
        workspaceId,
        source: "topup",
        tenths: 0,
        reason: "create the account",
      });
      const account = await accountFor(workspaceId);
      await prisma.creditAccount.update({
        where: { id: account.id },
        data: { monthlyGrantTenths: 50, grantResetAt: new Date(Date.now() - 1000) },
      });

      const now = new Date();
      const first = await credits.resetMonthlyGrants(now);
      const second = await credits.resetMonthlyGrants(now);

      expect(first.accountsReset).toBe(1);
      expect(second.accountsReset).toBe(0); // grantResetAt already advanced past `now`
      const after = await accountFor(workspaceId);
      expect(after.balanceTenths).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // Reconcile and orphaned holds
  // -------------------------------------------------------------------------

  describe("CreditReconcileService", () => {
    it("reports ok after a sequence of ledger operations", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 40,
        reason: "t",
      });
      await credits.settle({ holdId, actualTenths: 25 });

      const account = await accountFor(workspaceId);
      const result = await reconcile.reconcile(account.id);
      expect(result.ok).toBe(true);
      expect(result.lotsDriftTenths).toBe(0);
      expect(result.ledgerDriftTenths).toBe(0);
    });

    it("detects drift when a lot is hand-edited outside the facade", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const account = await accountFor(workspaceId);
      const [lot] = await lotsFor(workspaceId);
      await prisma.creditLot.update({ where: { id: lot!.id }, data: { remainingTenths: 50 } });

      const result = await reconcile.reconcile(account.id);
      expect(result.ok).toBe(false);
      expect(result.lotsDriftTenths).toBe(50); // 100 balance - 50 lots
    });
  });

  describe("CreditOrphanedHoldsService", () => {
    it("finds a held hold whose job already finished, and settles it on resolve", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 40,
        reason: "t",
      });

      // Simulate the completion path updating the job but never calling settle.
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "succeeded", creditsChargedTenths: 22, finishedAt: new Date() },
      });

      const found = await orphanedHolds.find();
      const orphan = found.find((o) => o.holdId === holdId);
      expect(orphan).toBeDefined();
      expect(orphan?.jobStatus).toBe("succeeded");

      const dryRun = await orphanedHolds.resolveAll({ holdIds: [holdId], dryRun: true });
      expect(dryRun[0]?.action).toBe("would_settle");
      // Dry run changed nothing.
      const stillHeld = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
      expect(stillHeld.status).toBe("held");

      const resolved = await orphanedHolds.resolveAll({ holdIds: [holdId], dryRun: false });
      expect(resolved[0]?.action).toBe("settled");
      const settled = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
      expect(settled.status).toBe("settled");
      expect(settled.settledTenths).toBe(22);
    });

    it("releases an orphaned hold for a failed job", async () => {
      const workspaceId = await newWorkspace();
      await credits.grantLot({ workspaceId, source: "topup", tenths: 100, reason: "fixture" });
      const jobId = await newJob(workspaceId);
      const { holdId } = await credits.reserve({
        workspaceId,
        jobId,
        worstCaseTenths: 40,
        reason: "t",
      });
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "failed", finishedAt: new Date() },
      });

      const resolved = await orphanedHolds.resolveAll({ holdIds: [holdId], dryRun: false });
      expect(resolved[0]?.action).toBe("released");

      const account = await accountFor(workspaceId);
      expect(account.balanceTenths).toBe(100);
    });
  });

  afterEach(() => {
    // Nothing to clean between cases: every test uses its own fresh workspace,
    // so leftover rows never interfere with a later assertion.
  });
});
