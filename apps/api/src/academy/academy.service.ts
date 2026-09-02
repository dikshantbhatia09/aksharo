import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import {
  ACADEMY_LIFETIME_CAP_TENTHS,
  ACADEMY_TRACKS,
  getCatalogTrack,
  tracksCompletedByExport,
} from "./academy.catalog.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { CREDITS_FACADE, type CreditsFacade } from "../credits/credits.facade.js";

import type {
  AcademyProgressResponse,
  ChangelogDismissedResponse,
  MarkStepDoneResult,
} from "./academy.dto.js";

/**
 * Academy progress, badges and the one-time per-track credit reward (brief
 * §2), plus the What's-new dismissal marker (brief §3).
 *
 * **Reward semantics.** `AcademyReward` is unique on `(workspaceId, trackId)`,
 * which is what makes a track's reward exactly-once per workspace — a
 * concurrent double-grant race is closed by that unique constraint at the DB
 * layer (`P2002` from a duplicate `create` is caught and treated as "someone
 * else already granted it", the same shape `referrals.service.ts` uses for
 * its `pending → granted` race). The reward is scoped to the *workspace*, not
 * the completing user, because credits are a workspace resource — but which
 * steps are done is tracked per user, so two editors in the same workspace
 * each see their own checklist progress.
 *
 * **Lifetime cap.** Before granting, the sum of every `AcademyReward.tenths`
 * already recorded for the workspace is checked against
 * `ACADEMY_LIFETIME_CAP_TENTHS` (100 credits). A track whose reward would
 * cross the cap is never granted for that workspace — no partial grant — and
 * because the cap only grows over time (rewards are additive, never
 * reversed), a track that lost the race against the cap once stays lost.
 */
@Injectable()
export class AcademyService {
  private readonly logger = new Logger(AcademyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CREDITS_FACADE) private readonly credits: CreditsFacade,
  ) {}

  // ---------------------------------------------------------------------
  // GET /academy/progress
  // ---------------------------------------------------------------------

  async getProgress(workspaceId: string, userId: string): Promise<AcademyProgressResponse> {
    const [progressRows, rewardRows] = await Promise.all([
      this.prisma.academyProgress.findMany({ where: { workspaceId, userId } }),
      this.prisma.academyReward.findMany({ where: { workspaceId } }),
    ]);
    const rewardByTrack = new Map(rewardRows.map((row) => [row.trackId, row]));
    const lifetimeGrantedTenths = rewardRows.reduce((sum, row) => sum + row.tenths, 0);

    const tracks = ACADEMY_TRACKS.map((track) => {
      const completedStepIds = progressRows
        .filter((row) => row.trackId === track.id)
        .map((row) => row.stepId);
      const reward = rewardByTrack.get(track.id);
      return {
        trackId: track.id,
        completedStepIds,
        totalSteps: track.steps.length,
        rewardGranted: Boolean(reward),
        rewardTenths: track.creditReward * 10,
      };
    });

    return { tracks, lifetimeGrantedTenths, lifetimeCapTenths: ACADEMY_LIFETIME_CAP_TENTHS };
  }

  // ---------------------------------------------------------------------
  // POST /academy/tracks/:trackId/steps/:stepId/done
  // ---------------------------------------------------------------------

  async markStepDone(
    workspaceId: string,
    userId: string,
    trackId: string,
    stepId: string,
    source: "manual" | "event" = "manual",
  ): Promise<MarkStepDoneResult> {
    const track = getCatalogTrack(trackId);
    if (!track) {
      throw new AppException(
        ERROR_CODES.academyUnknownTrack,
        `Unknown academy track "${trackId}".`,
        HttpStatus.NOT_FOUND,
      );
    }
    const step = track.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new AppException(
        ERROR_CODES.academyUnknownStep,
        `Unknown step "${stepId}" for track "${trackId}".`,
        HttpStatus.NOT_FOUND,
      );
    }

    const existing = await this.prisma.academyProgress.findUnique({
      where: { workspaceId_userId_trackId_stepId: { workspaceId, userId, trackId, stepId } },
    });
    if (!existing) {
      await this.prisma.academyProgress.create({
        data: { id: ulid(), workspaceId, userId, trackId, stepId, source },
      });
    }

    const doneCount = await this.prisma.academyProgress.count({
      where: { workspaceId, userId, trackId },
    });
    const trackCompleted = doneCount >= track.steps.length;

    let rewardGranted = false;
    if (trackCompleted) {
      rewardGranted = await this.maybeGrantReward(workspaceId, trackId);
    }

    return { trackId, stepId, alreadyDone: Boolean(existing), trackCompleted, rewardGranted };
  }

  /** Called by the `export.completed` listener for every track whose matching step fires on export. */
  async completeExportStepsForWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
    });
    if (!workspace) return;
    for (const { track, stepId } of tracksCompletedByExport()) {
      await this.markStepDone(workspaceId, workspace.ownerId, track.id, stepId, "event");
    }
  }

  /**
   * Grants the track's reward if it has not already been granted for this
   * workspace and doing so would not cross the lifetime cap.
   *
   * @returns whether a grant actually happened (idempotent: `false` both when
   * it was already granted before this call, and when the cap blocked it).
   */
  private async maybeGrantReward(workspaceId: string, trackId: string): Promise<boolean> {
    const track = getCatalogTrack(trackId);
    if (!track) return false;

    const already = await this.prisma.academyReward.findUnique({
      where: { workspaceId_trackId: { workspaceId, trackId } },
    });
    if (already) return false;

    const totals = await this.prisma.academyReward.aggregate({
      where: { workspaceId },
      _sum: { tenths: true },
    });
    const grantedSoFar = totals._sum.tenths ?? 0;
    const rewardTenths = track.creditReward * 10;
    if (grantedSoFar + rewardTenths > ACADEMY_LIFETIME_CAP_TENTHS) {
      this.logger.log(
        { workspaceId, trackId, grantedSoFar, rewardTenths },
        "academy reward skipped: lifetime cap reached",
      );
      return false;
    }

    try {
      // CONTRACTS §4 `CreditLotSource` is a frozen closed union — "grant" |
      // "topup" | "pass" | "referral" | "adjust" | "reversal" — and does not
      // include "academy" the way the brief's `grantLot(source: "academy")`
      // assumes. Flagged as a conflict in the final report rather than
      // silently widening a frozen type; `"adjust"` is used here (a manual
      // credit adjustment, which is what an Academy reward is until the
      // union is amended by an ADR) so the ledger stays honest about what
      // `CreditsFacade` actually accepts. `reason`/`refId` still identify it
      // as an Academy grant for the credit history and for B13's admin view.
      const lot = await this.credits.grantLot({
        workspaceId,
        source: "adjust",
        tenths: rewardTenths,
        reason: `Academy track completed: ${track.title}`,
        refId: trackId,
      });
      await this.prisma.academyReward.create({
        data: { id: ulid(), workspaceId, trackId, tenths: rewardTenths, lotId: lot.lotId },
      });
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "P2002") return false; // lost the race to a concurrent grant; not an error
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // What's new (brief §3)
  // ---------------------------------------------------------------------

  async getDismissedChangelogVersion(userId: string): Promise<ChangelogDismissedResponse> {
    const row = await this.prisma.changelogDismissal.findUnique({ where: { userId } });
    return { dismissedVersion: row?.version ?? null };
  }

  async dismissChangelog(userId: string, version: string): Promise<ChangelogDismissedResponse> {
    await this.prisma.changelogDismissal.upsert({
      where: { userId },
      update: { version, dismissedAt: new Date() },
      create: { id: ulid(), userId, version },
    });
    return { dismissedVersion: version };
  }
}
