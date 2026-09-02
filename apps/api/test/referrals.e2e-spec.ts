/**
 * The give-get referral loop (D53, F-607, B07b) against a real PostgreSQL:
 * claim, the abuse checks decided at claim time, the grant on a fake export
 * completion, the Free monthly cap, idempotency under a duplicate
 * completion event, and the tiered bonus.
 *
 * Drives `ReferralsService` directly against the real `LedgerCreditsFacade`
 * — the same shape `credits-ledger.e2e-spec.ts` uses — rather than through
 * HTTP: every check here is a database invariant (the unique
 * `referred_workspace_id`, the conditional `UPDATE … WHERE status =
 * 'pending'`) or a `credit_lots` row, and none of it needs auth or routing.
 * `EntitlementService` is a hand-rolled stub with a per-workspace plan map,
 * because the real one needs Redis for a cache this suite has no interest in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { AppException } from "../src/common/errors/error-codes.js";
import { CreditsLowBalanceNotifier } from "../src/credits/credits-low-balance.notifier.js";
import { LedgerCreditsFacade } from "../src/credits/ledger-credits.facade.js";
import { generateReferralCode, isReferralCode } from "../src/referrals/referral-code.js";
import {
  REFERRAL_BONUS_TENTHS,
  REFERRAL_FREE_MONTHLY_CAP,
  REFERRAL_REWARD_TENTHS,
} from "../src/referrals/referrals.constants.js";
import { ReferralsService } from "../src/referrals/referrals.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { NotifyService } from "../src/notify/notify.service.js";
import type { EntitlementService } from "../src/workspaces/entitlement.service.js";
import type { PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();
if (!available) console.warn(`[referrals.e2e] SKIPPED - ${skipReason}`);

let db: TestDatabase;
let prisma: PrismaClient;
let credits: LedgerCreditsFacade;
let referrals: ReferralsService;
let seq = 0;

/** Per-workspace plan the stub `EntitlementService` reports; defaults to "free". */
const planByWorkspace = new Map<string, "free" | "starter">();

describe.skipIf(!available)("ReferralsService (e2e)", () => {
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

    const stubEntitlements = {
      forWorkspace: async (workspaceId: string) => ({
        planKey: planByWorkspace.get(workspaceId) ?? "free",
      }),
    } as unknown as EntitlementService;

    referrals = new ReferralsService(prismaService, stubEntitlements, credits);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(() => {
    planByWorkspace.clear();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  function id(label: string): string {
    seq += 1;
    return `01J${label.slice(0, 4).toUpperCase().padEnd(4, "0")}${String(seq).padStart(19, "0")}`;
  }

  interface WorkspaceOptions {
    readonly email?: string;
    readonly ageBracket?: "adult" | "minor";
  }

  async function newWorkspace(options: WorkspaceOptions = {}): Promise<{
    workspaceId: string;
    userId: string;
  }> {
    const userId = id("usr");
    const workspaceId = id("wsp");
    await prisma.user.create({
      data: {
        id: userId,
        email: options.email ?? `${userId}@example.test`,
        ageBracket: options.ageBracket ?? "adult",
      },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId.toLowerCase(),
        name: "Test workspace",
        ownerId: userId,
        billingCountry: "IN",
      },
    });
    return { workspaceId, userId };
  }

  async function balanceOf(workspaceId: string): Promise<number> {
    const account = await prisma.creditAccount.findUnique({ where: { workspaceId } });
    return account?.balanceTenths ?? 0;
  }

  async function session(workspaceId: string, userId: string, ip: string): Promise<void> {
    await prisma.session.create({
      data: {
        id: id("ses"),
        userId,
        workspaceId,
        kind: "web",
        familyId: id("fam"),
        refreshTokenHash: id("hash").toLowerCase(),
        ip,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Personal code
  // -------------------------------------------------------------------------

  it("generates AK-XXXXXX codes, unambiguous alphabet", () => {
    for (let i = 0; i < 20; i += 1) {
      const code = generateReferralCode();
      expect(isReferralCode(code)).toBe(true);
      expect(code).toMatch(/^AK-[A-Z0-9]{6}$/);
    }
  });

  it("GET /referrals/me lazily creates and then reuses the same code", async () => {
    const { workspaceId } = await newWorkspace();
    const first = await referrals.myStats(workspaceId);
    expect(first.code.startsWith("AK-")).toBe(true);
    expect(first.pending).toBe(0);
    expect(first.granted).toBe(0);
    expect(first.promptEligible).toBe(false); // No completed export yet.

    const second = await referrals.myStats(workspaceId);
    expect(second.code).toBe(first.code);
  });

  // -------------------------------------------------------------------------
  // Claim
  // -------------------------------------------------------------------------

  it("a non-referral code is a no-op (B07's affiliate codes stay out of scope)", async () => {
    const { workspaceId } = await newWorkspace();
    const result = await referrals.claim({
      workspaceId,
      code: "SOMEAFFILIATECODE",
      ip: "10.0.0.1",
      userAgent: "vitest",
    });
    expect(result).toEqual({ claimed: false, status: null, reason: null });
  });

  it("claims a referral code into pending, and is idempotent on a repeat claim", async () => {
    const referrer = await newWorkspace();
    const referred = await newWorkspace();
    const code = await referrals.ensureCode(referrer.workspaceId);

    const first = await referrals.claim({
      workspaceId: referred.workspaceId,
      code,
      ip: "10.0.0.2",
      userAgent: "vitest",
    });
    expect(first).toEqual({ claimed: true, status: "pending", reason: null });

    const row = await prisma.referralReward.findUniqueOrThrow({
      where: { referredWorkspaceId: referred.workspaceId },
    });
    expect(row.referrerWorkspaceId).toBe(referrer.workspaceId);
    expect(row.status).toBe("pending");

    const second = await referrals.claim({
      workspaceId: referred.workspaceId,
      code,
      ip: "10.0.0.2",
      userAgent: "vitest",
    });
    expect(second).toEqual({ claimed: true, status: "pending", reason: null });
    expect(
      await prisma.referralReward.count({ where: { referredWorkspaceId: referred.workspaceId } }),
    ).toBe(1);
  });

  it("rejects self-referral", async () => {
    const referrer = await newWorkspace();
    const code = await referrals.ensureCode(referrer.workspaceId);

    await expect(
      referrals.claim({
        workspaceId: referrer.workspaceId,
        code,
        ip: "10.0.0.3",
        userAgent: "vitest",
      }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("rejects a minor referred workspace immediately", async () => {
    const referrer = await newWorkspace();
    const referred = await newWorkspace({ ageBracket: "minor" });
    const code = await referrals.ensureCode(referrer.workspaceId);

    const result = await referrals.claim({
      workspaceId: referred.workspaceId,
      code,
      ip: "10.0.0.4",
      userAgent: "vitest",
    });
    expect(result).toEqual({ claimed: true, status: "rejected", reason: "minor" });
  });

  it("rejects a minor referrer immediately", async () => {
    const referrer = await newWorkspace({ ageBracket: "minor" });
    const referred = await newWorkspace();
    const code = await referrals.ensureCode(referrer.workspaceId);

    const result = await referrals.claim({
      workspaceId: referred.workspaceId,
      code,
      ip: "10.0.0.5",
      userAgent: "vitest",
    });
    expect(result).toEqual({ claimed: true, status: "rejected", reason: "minor" });
  });

  it("rejects a disposable-email referred workspace", async () => {
    const referrer = await newWorkspace();
    const referred = await newWorkspace({ email: "throwaway@mailinator.com" });
    const code = await referrals.ensureCode(referrer.workspaceId);

    const result = await referrals.claim({
      workspaceId: referred.workspaceId,
      code,
      ip: "10.0.0.6",
      userAgent: "vitest",
    });
    expect(result).toEqual({ claimed: true, status: "rejected", reason: "disposable_email" });
  });

  it("rejects a claim from the same IP as the referrer's own session", async () => {
    const referrer = await newWorkspace();
    const referred = await newWorkspace();
    const code = await referrals.ensureCode(referrer.workspaceId);
    await session(referrer.workspaceId, referrer.userId, "198.51.100.7");

    const result = await referrals.claim({
      workspaceId: referred.workspaceId,
      code,
      ip: "198.51.100.7",
      userAgent: "some-other-agent",
    });
    expect(result).toEqual({ claimed: true, status: "rejected", reason: "same_device" });
  });

  it("rejects a claim from the same user agent as the referrer's own session", async () => {
    const referrer = await newWorkspace();
    const referred = await newWorkspace();
    const code = await referrals.ensureCode(referrer.workspaceId);
    await session(referrer.workspaceId, referrer.userId, "198.51.100.8");
    await prisma.session.updateMany({
      where: { workspaceId: referrer.workspaceId },
      data: { ua: "shared-device-ua" },
    });

    const result = await referrals.claim({
      workspaceId: referred.workspaceId,
      code,
      ip: "203.0.113.9",
      userAgent: "shared-device-ua",
    });
    expect(result).toEqual({ claimed: true, status: "rejected", reason: "same_device" });
  });

  // -------------------------------------------------------------------------
  // Grant on first completed export
  // -------------------------------------------------------------------------

  it("grants 30/30 non-expiring credits on the referred workspace's first completed export", async () => {
    const referrer = await newWorkspace();
    const referred = await newWorkspace();
    const code = await referrals.ensureCode(referrer.workspaceId);
    await referrals.claim({
      workspaceId: referred.workspaceId,
      code,
      ip: "10.0.1.1",
      userAgent: "vitest",
    });

    await referrals.grantForExport(referred.workspaceId);

    const row = await prisma.referralReward.findUniqueOrThrow({
      where: { referredWorkspaceId: referred.workspaceId },
    });
    expect(row.status).toBe("granted");
    expect(row.grantedAt).not.toBeNull();
    expect(row.referrerLotId).not.toBeNull();
    expect(row.referredLotId).not.toBeNull();

    expect(await balanceOf(referrer.workspaceId)).toBe(REFERRAL_REWARD_TENTHS);
    expect(await balanceOf(referred.workspaceId)).toBe(REFERRAL_REWARD_TENTHS);

    const referrerLot = await prisma.creditLot.findUniqueOrThrow({
      where: { id: row.referrerLotId! },
    });
    expect(referrerLot.expiresAt).toBeNull();
    expect(referrerLot.source).toBe("referral");
    const referredLot = await prisma.creditLot.findUniqueOrThrow({
      where: { id: row.referredLotId! },
    });
    expect(referredLot.expiresAt).toBeNull();
  });

  it("is a no-op for a workspace with no referral at all", async () => {
    const { workspaceId } = await newWorkspace();
    await expect(referrals.grantForExport(workspaceId)).resolves.toBeUndefined();
  });

  it("grants exactly once under a duplicate completion event", async () => {
    const referrer = await newWorkspace();
    const referred = await newWorkspace();
    const code = await referrals.ensureCode(referrer.workspaceId);
    await referrals.claim({
      workspaceId: referred.workspaceId,
      code,
      ip: "10.0.1.2",
      userAgent: "vitest",
    });

    await Promise.all([
      referrals.grantForExport(referred.workspaceId),
      referrals.grantForExport(referred.workspaceId),
    ]);
    await referrals.grantForExport(referred.workspaceId); // a third, sequential replay

    expect(await balanceOf(referrer.workspaceId)).toBe(REFERRAL_REWARD_TENTHS);
    expect(await balanceOf(referred.workspaceId)).toBe(REFERRAL_REWARD_TENTHS);
    const lotCount = await prisma.creditLot.count({
      where: { account: { workspaceId: referrer.workspaceId } },
    });
    expect(lotCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Free monthly cap
  // -------------------------------------------------------------------------

  it("rejects the 11th referral reward this month for a Free referrer (cap: 10)", async () => {
    const referrer = await newWorkspace();
    planByWorkspace.set(referrer.workspaceId, "free");

    // Fabricate REFERRAL_FREE_MONTHLY_CAP already-granted rewards this month.
    for (let i = 0; i < REFERRAL_FREE_MONTHLY_CAP; i += 1) {
      const referred = await newWorkspace();
      await prisma.referralReward.create({
        data: {
          id: id("rrw"),
          referrerWorkspaceId: referrer.workspaceId,
          referredWorkspaceId: referred.workspaceId,
          code: "AK-000000",
          status: "granted",
          grantedAt: new Date(),
        },
      });
    }

    const overflow = await newWorkspace();
    const code = await referrals.ensureCode(referrer.workspaceId);
    await referrals.claim({
      workspaceId: overflow.workspaceId,
      code,
      ip: "10.0.2.1",
      userAgent: "vitest",
    });
    await referrals.grantForExport(overflow.workspaceId);

    const row = await prisma.referralReward.findUniqueOrThrow({
      where: { referredWorkspaceId: overflow.workspaceId },
    });
    expect(row.status).toBe("rejected");
    expect(row.reason).toBe("cap");
    expect(await balanceOf(overflow.workspaceId)).toBe(0);
  });

  it("does not cap a Starter (paid) referrer", async () => {
    const referrer = await newWorkspace();
    planByWorkspace.set(referrer.workspaceId, "starter");

    for (let i = 0; i < REFERRAL_FREE_MONTHLY_CAP; i += 1) {
      const referred = await newWorkspace();
      await prisma.referralReward.create({
        data: {
          id: id("rrw"),
          referrerWorkspaceId: referrer.workspaceId,
          referredWorkspaceId: referred.workspaceId,
          code: "AK-000000",
          status: "granted",
          grantedAt: new Date(),
        },
      });
    }

    const overflow = await newWorkspace();
    const code = await referrals.ensureCode(referrer.workspaceId);
    await referrals.claim({
      workspaceId: overflow.workspaceId,
      code,
      ip: "10.0.2.2",
      userAgent: "vitest",
    });
    await referrals.grantForExport(overflow.workspaceId);

    const row = await prisma.referralReward.findUniqueOrThrow({
      where: { referredWorkspaceId: overflow.workspaceId },
    });
    expect(row.status).toBe("granted");
  });

  // -------------------------------------------------------------------------
  // Tiered bonus
  // -------------------------------------------------------------------------

  it("grants a +100 credit bonus once, on the 3rd granted referral", async () => {
    const referrer = await newWorkspace();

    for (let i = 0; i < 2; i += 1) {
      const referred = await newWorkspace();
      const code = await referrals.ensureCode(referrer.workspaceId);
      await referrals.claim({
        workspaceId: referred.workspaceId,
        code,
        ip: `10.0.3.${String(i)}`,
        userAgent: "vitest",
      });
      await referrals.grantForExport(referred.workspaceId);
    }

    let workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: referrer.workspaceId },
    });
    expect(workspace.referralBonusGrantedAt).toBeNull();

    const third = await newWorkspace();
    const code = await referrals.ensureCode(referrer.workspaceId);
    await referrals.claim({
      workspaceId: third.workspaceId,
      code,
      ip: "10.0.3.9",
      userAgent: "vitest",
    });
    await referrals.grantForExport(third.workspaceId);

    workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: referrer.workspaceId } });
    expect(workspace.referralBonusGrantedAt).not.toBeNull();

    // 3 × 30 (referrer side) + 100 bonus = 190.
    expect(await balanceOf(referrer.workspaceId)).toBe(
      3 * REFERRAL_REWARD_TENTHS + REFERRAL_BONUS_TENTHS,
    );

    // A 4th referral must not grant the bonus again.
    const fourth = await newWorkspace();
    const code2 = await referrals.ensureCode(referrer.workspaceId);
    await referrals.claim({
      workspaceId: fourth.workspaceId,
      code: code2,
      ip: "10.0.3.10",
      userAgent: "vitest",
    });
    await referrals.grantForExport(fourth.workspaceId);
    expect(await balanceOf(referrer.workspaceId)).toBe(
      4 * REFERRAL_REWARD_TENTHS + REFERRAL_BONUS_TENTHS,
    );
  });

  // -------------------------------------------------------------------------
  // The give-get prompt, shown once per workspace
  // -------------------------------------------------------------------------

  it("becomes prompt-eligible only after a succeeded export, and ineligible again once shown", async () => {
    const { workspaceId } = await newWorkspace();
    expect((await referrals.myStats(workspaceId)).promptEligible).toBe(false);

    const project = await prisma.project.create({
      data: { id: id("prj"), workspaceId, title: "Test project" },
    });
    await prisma.export.create({
      data: {
        id: id("exp"),
        workspaceId,
        projectId: project.id,
        status: "succeeded",
        kind: "mp4",
      },
    });
    expect((await referrals.myStats(workspaceId)).promptEligible).toBe(true);

    await referrals.markPromptShown(workspaceId);
    expect((await referrals.myStats(workspaceId)).promptEligible).toBe(false);
  });

  it("marks the prompt shown once, idempotently", async () => {
    const { workspaceId } = await newWorkspace();
    const first = await referrals.markPromptShown(workspaceId);
    const second = await referrals.markPromptShown(workspaceId);
    expect(second).toBe(first);

    const stats = await referrals.myStats(workspaceId);
    expect(stats.promptShownAt).toBe(first);
  });
});
