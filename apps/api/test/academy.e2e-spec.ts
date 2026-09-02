/**
 * Academy progress, badges and the one-time per-track credit reward (B12)
 * against a real PostgreSQL: step completion, exactly-once reward on track
 * completion, the 25-credit-per-track / 100-credit-lifetime cap, idempotency
 * on a repeat "Mark done", and `export.completed` auto-completing the
 * matching step. Same shape as `referrals.e2e-spec.ts`: drives
 * `AcademyService` directly against the real `LedgerCreditsFacade`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { ACADEMY_LIFETIME_CAP_TENTHS } from "../src/academy/academy.catalog.js";
import { AcademyService } from "../src/academy/academy.service.js";
import { AppException } from "../src/common/errors/error-codes.js";
import { CreditsLowBalanceNotifier } from "../src/credits/credits-low-balance.notifier.js";
import { LedgerCreditsFacade } from "../src/credits/ledger-credits.facade.js";

import type { TestDatabase } from "./db-harness.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { NotifyService } from "../src/notify/notify.service.js";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();
if (!available) console.warn(`[academy.e2e] SKIPPED - ${skipReason}`);

let db: TestDatabase;
let prisma: PrismaClient;
let credits: LedgerCreditsFacade;
let academy: AcademyService;
let seq = 0;

describe.skipIf(!available)("AcademyService (e2e)", () => {
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

    const notifier = new CreditsLowBalanceNotifier(prismaService, stubNotify, {
      emit: () => undefined,
    } as unknown as EventEmitter2);
    credits = new LedgerCreditsFacade(prismaService, notifier);
    academy = new AcademyService(prismaService, credits);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  function id(label: string): string {
    seq += 1;
    return `01J${label.slice(0, 4).toUpperCase().padEnd(4, "0")}${String(seq).padStart(19, "0")}`;
  }

  async function newWorkspace(): Promise<{ workspaceId: string; userId: string }> {
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
    return { workspaceId, userId };
  }

  async function balanceOf(workspaceId: string): Promise<number> {
    const account = await prisma.creditAccount.findUnique({ where: { workspaceId } });
    return account?.balanceTenths ?? 0;
  }

  async function completeAllSteps(
    workspaceId: string,
    userId: string,
    trackId: string,
    stepIds: readonly string[],
  ): Promise<void> {
    for (const stepId of stepIds) {
      await academy.markStepDone(workspaceId, userId, trackId, stepId, "manual");
    }
  }

  it("marking an unknown track throws academy/unknown_track", async () => {
    const { workspaceId, userId } = await newWorkspace();
    await expect(
      academy.markStepDone(workspaceId, userId, "no-such-track", "step", "manual"),
    ).rejects.toThrow(AppException);
  });

  it("marking an unknown step of a real track throws academy/unknown_step", async () => {
    const { workspaceId, userId } = await newWorkspace();
    await expect(
      academy.markStepDone(workspaceId, userId, "hinglish-reel", "no-such-step", "manual"),
    ).rejects.toThrow(AppException);
  });

  it("is idempotent: marking the same step twice reports alreadyDone the second time", async () => {
    const { workspaceId, userId } = await newWorkspace();
    const first = await academy.markStepDone(
      workspaceId,
      userId,
      "hinglish-reel",
      "upload-clip",
      "manual",
    );
    expect(first.alreadyDone).toBe(false);
    const second = await academy.markStepDone(
      workspaceId,
      userId,
      "hinglish-reel",
      "upload-clip",
      "manual",
    );
    expect(second.alreadyDone).toBe(true);
  });

  it("grants the track's credit reward exactly once, on the last step", async () => {
    const { workspaceId, userId } = await newWorkspace();
    const steps = ["upload-clip", "review-transcript", "pick-style"];
    for (const stepId of steps) {
      const result = await academy.markStepDone(
        workspaceId,
        userId,
        "hinglish-reel",
        stepId,
        "manual",
      );
      expect(result.trackCompleted).toBe(false);
      expect(result.rewardGranted).toBe(false);
    }
    const last = await academy.markStepDone(
      workspaceId,
      userId,
      "hinglish-reel",
      "export",
      "manual",
    );
    expect(last.trackCompleted).toBe(true);
    expect(last.rewardGranted).toBe(true);
    expect(await balanceOf(workspaceId)).toBe(150); // 15 credits = 150 tenths

    // Re-marking the last step again (a retried request) must not grant twice.
    const repeat = await academy.markStepDone(
      workspaceId,
      userId,
      "hinglish-reel",
      "export",
      "manual",
    );
    expect(repeat.rewardGranted).toBe(false);
    expect(await balanceOf(workspaceId)).toBe(150);
  });

  it("never exceeds the 25-credit-per-track cap for any seed track", async () => {
    const { workspaceId, userId } = await newWorkspace();
    await completeAllSteps(workspaceId, userId, "agency-workflow", [
      "invite-team",
      "tag-clients",
      "apply-brand-kit",
      "export-report",
    ]);
    expect(await balanceOf(workspaceId)).toBeLessThanOrEqual(250); // 25 credits
  });

  it("stops granting once the workspace's 100-credit lifetime cap would be crossed", async () => {
    const { workspaceId, userId } = await newWorkspace();
    // hinglish-reel(15) + podcast-clips(20) + captions-in-premiere(15) = 50 credits.
    await completeAllSteps(workspaceId, userId, "hinglish-reel", [
      "upload-clip",
      "review-transcript",
      "pick-style",
      "export",
    ]);
    await completeAllSteps(workspaceId, userId, "podcast-clips", [
      "upload-episode",
      "diarise-speakers",
      "mark-chapters",
      "export-clips",
    ]);
    await completeAllSteps(workspaceId, userId, "captions-in-premiere", [
      "install-plugin",
      "link-project",
      "adjust-captions",
      "sync-back",
    ]);
    expect(await balanceOf(workspaceId)).toBe(500); // 50 credits so far, under the 100 cap

    // Manually top the workspace's *recorded Academy rewards* up to just under
    // the cap, via the real facade (so the credit balance stays consistent),
    // so agency-workflow's 25-credit reward (250 tenths) would cross it,
    // without relying on a fifth real track existing.
    const fixtureLot = await credits.grantLot({
      workspaceId,
      source: "adjust",
      tenths: 700,
      reason: "test fixture: push workspace to the cap boundary",
    });
    await prisma.academyReward.create({
      data: {
        id: id("rwd"),
        workspaceId,
        trackId: "__fixture-cap-filler",
        tenths: 700,
        lotId: fixtureLot.lotId,
      },
    });

    const balanceBeforeAgency = await balanceOf(workspaceId);
    expect(balanceBeforeAgency).toBe(1_200);

    const last = await academy.markStepDone(
      workspaceId,
      userId,
      "agency-workflow",
      "invite-team",
      "manual",
    );
    expect(last.trackCompleted).toBe(false);
    await academy.markStepDone(workspaceId, userId, "agency-workflow", "tag-clients", "manual");
    await academy.markStepDone(workspaceId, userId, "agency-workflow", "apply-brand-kit", "manual");
    const final = await academy.markStepDone(
      workspaceId,
      userId,
      "agency-workflow",
      "export-report",
      "manual",
    );

    expect(final.trackCompleted).toBe(true);
    expect(final.rewardGranted).toBe(false); // blocked: would cross ACADEMY_LIFETIME_CAP_TENTHS
    expect(await balanceOf(workspaceId)).toBe(balanceBeforeAgency); // unchanged
    expect(balanceBeforeAgency).toBeGreaterThan(ACADEMY_LIFETIME_CAP_TENTHS - 250);
  });

  it("export.completed auto-completes the matching step for the workspace owner", async () => {
    const { workspaceId, userId } = await newWorkspace();
    await completeAllSteps(workspaceId, userId, "hinglish-reel", [
      "upload-clip",
      "review-transcript",
      "pick-style",
    ]);

    await academy.completeExportStepsForWorkspace(workspaceId);

    const progress = await academy.getProgress(workspaceId, userId);
    const track = progress.tracks.find((t) => t.trackId === "hinglish-reel")!;
    expect(track.completedStepIds).toContain("export");
    expect(track.rewardGranted).toBe(true);
  });

  it("What's-new: dismissing is per-user and returns the version back", async () => {
    const { userId } = await newWorkspace();
    expect((await academy.getDismissedChangelogVersion(userId)).dismissedVersion).toBeNull();
    await academy.dismissChangelog(userId, "0.1.0");
    expect((await academy.getDismissedChangelogVersion(userId)).dismissedVersion).toBe("0.1.0");
    // A later dismiss overwrites, not appends.
    await academy.dismissChangelog(userId, "0.2.0");
    expect((await academy.getDismissedChangelogVersion(userId)).dismissedVersion).toBe("0.2.0");
  });
});
