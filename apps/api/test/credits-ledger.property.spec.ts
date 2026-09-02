/**
 * The credits ledger concurrency property test — brief §8, the definition of
 * done for B02.
 *
 * N = {@link CONCURRENT_WORKERS} concurrent workers perform
 * {@link TOTAL_OPERATIONS} random `reserve`/`settle`/`release`/`reverse`/
 * `grantLot`/`expireLots`/`revokeLot` calls against ONE credit account, run against a real
 * Postgres (CONTRACTS §9: property tests use fast-check). After every batch of
 * concurrent operations, three things must hold for that account:
 *
 *   1. `balance_tenths` = Σ `credit_lots.remaining_tenths` = Σ
 *      `credit_ledger.delta_tenths`, and every one is ≥ 0 (06 invariant 1).
 *   2. Exactly one terminal ledger write per hold — at most one of
 *      {settle-exact, settle-under (a `release` row), settle-over (a `settle`
 *      row for the delta), a plain `release`} ever lands for a given job,
 *      which is what the claim-first CAS in `LedgerCreditsFacade.settle`/
 *      `.release` is FOR.
 *   3. No lost updates: (1) is itself the proof — a lost update (two
 *      concurrent writers stepping on each other) shows up as drift between
 *      the cached balance and the two independently-recomputed sums.
 *
 * Real concurrency, not simulated: each operation opens its own connection
 * through the same `PrismaClient` pool and the assertions run only once every
 * worker in a batch has settled, so the invariant is checked against a
 * genuinely quiescent, race-exercised state rather than a mocked one.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { CreditsLowBalanceNotifier } from "../src/credits/credits-low-balance.notifier.js";
import { LedgerCreditsFacade } from "../src/credits/ledger-credits.facade.js";

import type { TestDatabase } from "./db-harness.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { NotifyService } from "../src/notify/notify.service.js";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { $Enums, PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();
if (!available) {
  console.warn(`[credits-ledger.property] SKIPPED - ${skipReason}`);
}

/**
 * N in "N concurrent workers" and the total operation count (brief §8:
 * N=50, 2,000 operations — the defaults, and what `pnpm test:property` runs).
 * Overridable for a fast local smoke run while developing; never overridden in
 * CI or in the numbers this WP reports as the DoD run.
 */
const CONCURRENT_WORKERS = Number(process.env["CREDITS_PROPERTY_WORKERS"] ?? 50);
const TOTAL_OPERATIONS = Number(process.env["CREDITS_PROPERTY_OPERATIONS"] ?? 2_000);
const BATCHES = Math.ceil(TOTAL_OPERATIONS / CONCURRENT_WORKERS);
/** How many random sequences fast-check tries; each is the full operation run. */
const PROPERTY_RUNS = Number(process.env["CREDITS_PROPERTY_RUNS"] ?? 1);

const OP_KINDS = ["reserve", "settle", "release", "reverse", "grant", "expire", "revoke"] as const;
type OpKind = (typeof OP_KINDS)[number];
const GRANT_SOURCES: $Enums.CreditLotSource[] = ["grant", "topup", "pass", "referral", "adjust"];

interface OpSpec {
  readonly kind: OpKind;
  readonly amount: number;
  readonly selector: number;
  readonly settleFactor: number;
  readonly grantSource: $Enums.CreditLotSource;
  readonly grantExpiryDays: number | null;
  /** B02b: `revokeLot`'s idempotency key — mostly unique, occasionally not, so
   *  the property exercises both a real claw-back and an idempotent replay. */
  readonly refundSeed: number;
}

const opArbitrary: fc.Arbitrary<OpSpec> = fc.record({
  kind: fc.constantFrom(...OP_KINDS),
  amount: fc.integer({ min: 1, max: 400 }),
  selector: fc.nat(),
  settleFactor: fc.double({ min: 0, max: 2, noNaN: true }),
  grantSource: fc.constantFrom(...GRANT_SOURCES),
  grantExpiryDays: fc.option(fc.integer({ min: -3, max: 45 }), { nil: null }),
  refundSeed: fc.integer({ min: 0, max: 500 }),
});

let db: TestDatabase;
let prisma: PrismaClient;
let credits: LedgerCreditsFacade;
let accountId: string;
let workspaceId: string;
let seq = 0;

function id(label: string): string {
  seq += 1;
  return `01J${label.slice(0, 4).toUpperCase().padEnd(4, "0")}${String(seq).padStart(19, "0")}`;
}

async function newJob(): Promise<string> {
  const jobId = id("job");
  await prisma.job.create({
    data: { id: jobId, workspaceId, type: "ai.transcribe", jobKey: `prop:${jobId}` },
  });
  return jobId;
}

interface Snapshot {
  readonly balanceTenths: number;
  readonly lotsSumTenths: number;
  readonly ledgerSumTenths: number;
}

async function snapshot(): Promise<Snapshot> {
  const [account, lots, ledger] = await Promise.all([
    prisma.creditAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { balanceTenths: true },
    }),
    prisma.creditLot.aggregate({ where: { accountId }, _sum: { remainingTenths: true } }),
    prisma.creditLedger.aggregate({ where: { accountId }, _sum: { deltaTenths: true } }),
  ]);
  return {
    balanceTenths: account.balanceTenths,
    lotsSumTenths: lots._sum.remainingTenths ?? 0,
    ledgerSumTenths: ledger._sum.deltaTenths ?? 0,
  };
}

function assertInvariant(snap: Snapshot, where: string): void {
  expect(snap.balanceTenths, `${where}: balance >= 0`).toBeGreaterThanOrEqual(0);
  expect(snap.balanceTenths, `${where}: balance == Σ lots`).toBe(snap.lotsSumTenths);
  expect(snap.balanceTenths, `${where}: balance == Σ ledger`).toBe(snap.ledgerSumTenths);
}

interface HoldRef {
  readonly holdId: string;
  readonly jobId: string;
  readonly amountTenths: number;
}

async function liveHolds(): Promise<HoldRef[]> {
  const rows = await prisma.creditHold.findMany({
    where: { accountId, status: "held" },
    select: { id: true, jobId: true, amountTenths: true },
  });
  return rows.map((r) => ({ holdId: r.id, jobId: r.jobId, amountTenths: r.amountTenths }));
}

async function settledJobIds(): Promise<string[]> {
  const rows = await prisma.creditHold.findMany({
    where: { accountId, status: { in: ["settled", "partially_settled"] } },
    select: { jobId: true },
  });
  return rows.map((r) => r.jobId);
}

/** Lots still worth targeting with `revokeLot` (B02b). A lot dropping to zero
 *  between this snapshot and the op running is a normal race — `revokeLot`
 *  just reports the whole request as shortfall, no error. */
async function liveLotIds(): Promise<string[]> {
  const rows = await prisma.creditLot.findMany({
    where: { accountId, remainingTenths: { gt: 0 } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** A 26-char, `CHAR(26)`-safe idempotency key for `revokeLot`. Deliberately
 *  low-cardinality (mod 500) so the property also exercises the idempotent
 *  replay path, not just first-time claw-backs. */
function refundId(seed: number): string {
  return `01JPROPREFUND${String(seed % 500).padStart(13, "0")}`;
}

/** One operation, tolerant of the races its own concurrent siblings cause. */
async function runOp(
  op: OpSpec,
  holds: readonly HoldRef[],
  settled: readonly string[],
  lots: readonly string[],
): Promise<void> {
  try {
    switch (op.kind) {
      case "reserve": {
        const jobId = await newJob();
        await credits.reserve({
          workspaceId,
          jobId,
          worstCaseTenths: op.amount,
          reason: "property test",
        });
        return;
      }
      case "settle": {
        if (holds.length === 0) return;
        const target = holds[op.selector % holds.length]!;
        const actualTenths = Math.max(0, Math.round(target.amountTenths * op.settleFactor));
        await credits.settle({ holdId: target.holdId, actualTenths });
        return;
      }
      case "release": {
        if (holds.length === 0) return;
        const target = holds[op.selector % holds.length]!;
        await credits.release({ holdId: target.holdId });
        return;
      }
      case "reverse": {
        if (settled.length === 0) return;
        const jobId = settled[op.selector % settled.length]!;
        await credits.reverse({
          workspaceId,
          jobId,
          tenths: (op.amount % 200) + 1,
          reason: "property test reversal",
        });
        return;
      }
      case "grant": {
        const expiresAt =
          op.grantExpiryDays === null
            ? undefined
            : new Date(Date.now() + op.grantExpiryDays * 86_400_000);
        await credits.grantLot({
          workspaceId,
          source: op.grantSource,
          tenths: op.amount,
          reason: "property test grant",
          ...(expiresAt === undefined ? {} : { expiresAt }),
        });
        return;
      }
      case "expire": {
        await credits.expireLots(new Date());
        return;
      }
      case "revoke": {
        if (lots.length === 0) return;
        const lotId = lots[op.selector % lots.length]!;
        await credits.revokeLot({
          lotId,
          tenths: (op.amount % 200) + 1,
          reason: "property test revoke",
          refundId: refundId(op.refundSeed),
        });
        return;
      }
    }
  } catch (error) {
    // Expected, non-fatal outcomes of genuine concurrency and randomness:
    // insufficient balance, a hold two workers both picked (one wins, the
    // other's target is gone by the time it runs), a reversal source that
    // another worker already reversed away, a lot another worker's revoke
    // already drained. Anything else is a real failure and is rethrown so
    // the batch (and the property) fails loudly.
    const code = (error as { code?: unknown } | undefined)?.code;
    const known = [
      "credits/insufficient",
      "credits/hold_not_found",
      "credits/reversal_source_not_found",
      "credits/lot_not_found",
    ];
    if (typeof code === "string" && known.includes(code)) return;
    throw error;
  }
}

async function runBatches(ops: readonly OpSpec[]): Promise<void> {
  for (let batch = 0; batch < BATCHES; batch += 1) {
    const slice = ops.slice(batch * CONCURRENT_WORKERS, (batch + 1) * CONCURRENT_WORKERS);
    const [holds, settled, lots] = await Promise.all([liveHolds(), settledJobIds(), liveLotIds()]);
    await Promise.all(slice.map((op) => runOp(op, holds, settled, lots)));
    assertInvariant(await snapshot(), `after batch ${String(batch + 1)}/${String(BATCHES)}`);
  }
}

/** Exactly one terminal ledger write ever lands for a given job's hold. */
async function assertExactlyOneSettlementPerHold(): Promise<void> {
  const rows = await prisma.$queryRaw<{ job_id: string; terminal_writes: bigint }[]>`
    SELECT h.job_id, COUNT(*) AS terminal_writes
    FROM credit_holds h
    JOIN credit_ledger l
      ON l.account_id = h.account_id AND l.ref_type = 'job' AND l.ref_id = h.job_id
         AND l.kind IN ('settle', 'release')
    WHERE h.account_id = ${accountId}
    GROUP BY h.job_id
    HAVING COUNT(*) > 1
  `;
  expect(rows, "no job has more than one terminal settle/release ledger write").toEqual([]);
}

describe.skipIf(!available)("credits ledger concurrency property (brief §8)", () => {
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
    credits = new LedgerCreditsFacade(
      prismaService,
      new CreditsLowBalanceNotifier(prismaService, stubNotify, {
        emit: () => undefined,
      } as unknown as EventEmitter2),
    );
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it(
    `N=${String(CONCURRENT_WORKERS)} workers, ${String(TOTAL_OPERATIONS)} random operations, ` +
      "invariant holds after every batch",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(opArbitrary, { minLength: TOTAL_OPERATIONS, maxLength: TOTAL_OPERATIONS }),
          async (ops) => {
            // A fresh account per fast-check run: the property is about ONE
            // account's invariant, not about accounts being independent.
            const userId = id("usr");
            workspaceId = id("wsp");
            await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
            await prisma.workspace.create({
              data: {
                id: workspaceId,
                slug: workspaceId.toLowerCase(),
                name: "Property test workspace",
                ownerId: userId,
                billingCountry: "IN",
              },
            });
            const account = await credits.grantLot({
              workspaceId,
              source: "topup",
              tenths: 5_000,
              reason: "property test seed",
            });
            accountId = (await prisma.creditLot.findUniqueOrThrow({ where: { id: account.lotId } }))
              .accountId;

            assertInvariant(await snapshot(), "seed");
            await runBatches(ops);
            assertInvariant(await snapshot(), "final");
            await assertExactlyOneSettlementPerHold();
          },
        ),
        { numRuns: PROPERTY_RUNS, endOnFailure: true },
      );
    },
    10 * 60_000,
  );
});
