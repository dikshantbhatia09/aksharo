import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { isDisposableEmail } from "./disposable-email.js";
import { hashFingerprint } from "./fingerprint.js";
import { generateReferralCode, isReferralCode, normalizeReferralCode } from "./referral-code.js";
import {
  REFERRAL_BONUS_TENTHS,
  REFERRAL_BONUS_THRESHOLD,
  REFERRAL_FREE_MONTHLY_CAP,
  REFERRAL_REJECT_REASONS,
  REFERRAL_REWARD_TENTHS,
} from "./referrals.constants.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { CREDITS_FACADE, type CreditsFacade } from "../credits/credits.facade.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { ClaimReferralResult, ReferralStats } from "./referrals.dto.js";

export interface ClaimContext {
  readonly workspaceId: string;
  readonly code: string;
  readonly ip: string;
  readonly userAgent: string | undefined;
}

function startOfCalendarMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The give-get referral loop (D53, F-607, B07b).
 *
 * Two independent entry points, matching the brief's state machine:
 *
 * - `claim()` — `POST /referrals/claim`, called during onboarding. Creates a
 *   `pending` row and runs every check that can be decided immediately
 *   (self-referral, minors, disposable email, same device/IP as the
 *   referrer's most recent session) — these reject at claim time so the
 *   caller gets an honest answer immediately rather than a silent no-op
 *   later.
 * - `grantForExport()` — the `export.completed` listener. Runs only the
 *   check that cannot be known until now (the referrer's monthly cap, which
 *   is a moving target between claim and first export) and, if the referral
 *   is still `pending`, grants both sides.
 *
 * **Exactly-once.** `referral_rewards.referred_workspace_id` is unique, so a
 * workspace can be referred once ever — `claim()`'s insert simply fails (as
 * a 409) on a second code. The grant itself uses the same conditional
 * `UPDATE … WHERE status = 'pending'` idempotency trick
 * `render-completion.handler.ts`'s `claimManifest` uses for the identical
 * problem (a replayed completion event): only the update that actually flips
 * `pending → granted`/`rejected` proceeds to call `grantLot`; a replay finds
 * the row already resolved and returns immediately.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    @Inject(CREDITS_FACADE) private readonly credits: CreditsFacade,
  ) {}

  // ---------------------------------------------------------------------
  // GET /referrals/me
  // ---------------------------------------------------------------------

  async myStats(workspaceId: string): Promise<ReferralStats> {
    const code = await this.ensureCode(workspaceId);

    const [pending, granted, rejected, workspace, completedExports] = await Promise.all([
      this.prisma.referralReward.count({
        where: { referrerWorkspaceId: workspaceId, status: "pending" },
      }),
      this.prisma.referralReward.count({
        where: { referrerWorkspaceId: workspaceId, status: "granted" },
      }),
      this.prisma.referralReward.count({
        where: { referrerWorkspaceId: workspaceId, status: "rejected" },
      }),
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { referralBonusGrantedAt: true, referralPromptShownAt: true },
      }),
      this.prisma.export.count({ where: { workspaceId, status: "succeeded" } }),
    ]);

    return {
      code,
      pending,
      granted,
      rejected,
      bonusGrantedAt: workspace.referralBonusGrantedAt?.toISOString() ?? null,
      promptShownAt: workspace.referralPromptShownAt?.toISOString() ?? null,
      promptEligible: workspace.referralPromptShownAt === null && completedExports > 0,
    };
  }

  /** Lazily creates the personal code — collision retries a few times before giving up. */
  async ensureCode(workspaceId: string): Promise<string> {
    const existing = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { referralCode: true },
    });
    if (existing.referralCode !== null) return existing.referralCode;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateReferralCode();
      try {
        const claimed = await this.prisma.workspace.updateMany({
          where: { id: workspaceId, referralCode: null },
          data: { referralCode: code },
        });
        if (claimed.count === 1) return code;
      } catch {
        // Unique-constraint collision on `code` (vanishingly unlikely) — retry.
      }
      // Either a collision, or a concurrent caller already set it — re-read
      // and return whichever won.
      const row = await this.prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { referralCode: true },
      });
      if (row.referralCode !== null) return row.referralCode;
    }
    throw new AppException(
      ERROR_CODES.internal,
      "Could not allocate a referral code.",
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // ---------------------------------------------------------------------
  // POST /referrals/prompt/shown
  // ---------------------------------------------------------------------

  async markPromptShown(workspaceId: string): Promise<string> {
    const now = new Date();
    const updated = await this.prisma.workspace.updateMany({
      where: { id: workspaceId, referralPromptShownAt: null },
      data: { referralPromptShownAt: now },
    });
    if (updated.count === 0) {
      const row = await this.prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { referralPromptShownAt: true },
      });
      return (row.referralPromptShownAt ?? now).toISOString();
    }
    return now.toISOString();
  }

  // ---------------------------------------------------------------------
  // POST /referrals/claim
  // ---------------------------------------------------------------------

  async claim(context: ClaimContext): Promise<ClaimReferralResult> {
    const normalized = normalizeReferralCode(context.code);
    if (!isReferralCode(normalized)) {
      // Not a referral code — B07's affiliate attribution owns everything
      // else posted from the same onboarding field. Not an error: the
      // frontend posts whatever the user typed.
      return { claimed: false, status: null, reason: null };
    }

    const referrer = await this.prisma.workspace.findUnique({
      where: { referralCode: normalized },
      select: { id: true, ownerId: true },
    });
    if (referrer === null) {
      throw new AppException(
        ERROR_CODES.notFound,
        "No workspace with that referral code.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (referrer.id === context.workspaceId) {
      throw new AppException(
        ERROR_CODES.badRequest,
        "You cannot refer yourself.",
        HttpStatus.BAD_REQUEST,
        { reason: REFERRAL_REJECT_REASONS.selfReferral },
      );
    }

    const existing = await this.prisma.referralReward.findUnique({
      where: { referredWorkspaceId: context.workspaceId },
      select: { status: true, reason: true },
    });
    if (existing !== null) {
      // Idempotent: a workspace claims at most once, ever.
      return { claimed: true, status: existing.status, reason: existing.reason };
    }

    const [referredOwner, referrerOwner] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: context.workspaceId },
        select: { owner: { select: { email: true, ageBracket: true } } },
      }),
      this.prisma.user.findUnique({
        where: { id: referrer.ownerId },
        select: { ageBracket: true },
      }),
    ]);

    const deviceHash = context.userAgent === undefined ? null : hashFingerprint(context.userAgent);
    const ipHash = hashFingerprint(context.ip);

    const rejection = await this.immediateRejectionReason({
      referredEmail: referredOwner.owner.email,
      referredIsMinor: referredOwner.owner.ageBracket === "minor",
      referrerIsMinor: referrerOwner?.ageBracket === "minor",
      referrerWorkspaceId: referrer.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const id = ulid();
    try {
      await this.prisma.referralReward.create({
        data: {
          id,
          referrerWorkspaceId: referrer.id,
          referredWorkspaceId: context.workspaceId,
          code: normalized,
          status: rejection === null ? "pending" : "rejected",
          reason: rejection,
          deviceHash,
          ipHash,
        },
      });
    } catch {
      // Race: two concurrent claims for the same referred workspace. The
      // unique constraint on `referred_workspace_id` lost this one — read
      // back whichever won.
      const row = await this.prisma.referralReward.findUnique({
        where: { referredWorkspaceId: context.workspaceId },
        select: { status: true, reason: true },
      });
      if (row !== null) return { claimed: true, status: row.status, reason: row.reason };
      throw new AppException(
        ERROR_CODES.conflict,
        "Could not record the referral claim.",
        HttpStatus.CONFLICT,
      );
    }

    this.logger.log(
      {
        referredWorkspaceId: context.workspaceId,
        referrerWorkspaceId: referrer.id,
        rejected: rejection,
      },
      "referral claimed",
    );

    return {
      claimed: true,
      status: rejection === null ? "pending" : "rejected",
      reason: rejection,
    };
  }

  /** Checks decidable at claim time, without knowing the referrer's future monthly count. */
  private async immediateRejectionReason(input: {
    readonly referredEmail: string;
    readonly referredIsMinor: boolean;
    readonly referrerIsMinor: boolean | undefined;
    readonly referrerWorkspaceId: string;
    readonly ip: string;
    readonly userAgent: string | undefined;
  }): Promise<string | null> {
    if (input.referredIsMinor || input.referrerIsMinor === true) {
      return REFERRAL_REJECT_REASONS.minor;
    }
    if (isDisposableEmail(input.referredEmail)) {
      return REFERRAL_REJECT_REASONS.disposableEmail;
    }

    const referrerSession = await this.prisma.session.findFirst({
      where: { workspaceId: input.referrerWorkspaceId },
      orderBy: { createdAt: "desc" },
      select: { ip: true, ua: true },
    });
    if (referrerSession !== null) {
      const sameIp = referrerSession.ip !== null && referrerSession.ip === input.ip;
      const sameUa =
        referrerSession.ua !== null &&
        input.userAgent !== undefined &&
        referrerSession.ua === input.userAgent;
      if (sameIp || sameUa) return REFERRAL_REJECT_REASONS.sameDevice;
    }

    return null;
  }

  // ---------------------------------------------------------------------
  // export.completed listener
  // ---------------------------------------------------------------------

  /**
   * Called once per completed export; a no-op unless this is the referred
   * workspace's still-`pending` referral. Safe to call for every export
   * (including a workspace with no referral at all, or later ones after the
   * first) — the conditional update only ever matches the one row while it
   * is still `pending`.
   */
  async grantForExport(referredWorkspaceId: string): Promise<void> {
    const pending = await this.prisma.referralReward.findFirst({
      where: { referredWorkspaceId, status: "pending" },
    });
    if (pending === null) return;

    const targetStatus = await this.decideGrantOutcome(pending.referrerWorkspaceId);

    const claimed = await this.prisma.referralReward.updateMany({
      where: { id: pending.id, status: "pending" },
      data:
        targetStatus === "granted"
          ? { status: "granted", grantedAt: new Date() }
          : { status: "rejected", reason: REFERRAL_REJECT_REASONS.cap },
    });
    if (claimed.count === 0) {
      // Lost the race (a concurrent completion event already resolved this
      // row) or it was already resolved — either way, nothing left to do.
      return;
    }

    if (targetStatus !== "granted") {
      this.logger.log(
        { referralId: pending.id, referrerWorkspaceId: pending.referrerWorkspaceId },
        "referral reward rejected at grant time (cap)",
      );
      return;
    }

    const [referrerLot, referredLot] = await Promise.all([
      this.credits.grantLot({
        workspaceId: pending.referrerWorkspaceId,
        source: "referral",
        tenths: REFERRAL_REWARD_TENTHS,
        reason: `Referral reward — ${pending.code}`,
        refId: pending.id,
      }),
      this.credits.grantLot({
        workspaceId: pending.referredWorkspaceId,
        source: "referral",
        tenths: REFERRAL_REWARD_TENTHS,
        reason: `Referral welcome bonus — ${pending.code}`,
        refId: pending.id,
      }),
    ]);

    await this.prisma.referralReward.update({
      where: { id: pending.id },
      data: { referrerLotId: referrerLot.lotId, referredLotId: referredLot.lotId },
    });

    this.logger.log(
      { referralId: pending.id, referrerWorkspaceId: pending.referrerWorkspaceId },
      "referral reward granted",
    );

    await this.maybeGrantTierBonus(pending.referrerWorkspaceId);
  }

  private async decideGrantOutcome(referrerWorkspaceId: string): Promise<"granted" | "capped"> {
    const entitlement = await this.entitlements.forWorkspace(referrerWorkspaceId);
    if (entitlement.planKey !== "free") return "granted";

    const monthStart = startOfCalendarMonth(new Date());
    const grantedThisMonth = await this.prisma.referralReward.count({
      where: {
        referrerWorkspaceId,
        status: "granted",
        grantedAt: { gte: monthStart },
      },
    });
    return grantedThisMonth >= REFERRAL_FREE_MONTHLY_CAP ? "capped" : "granted";
  }

  private async maybeGrantTierBonus(referrerWorkspaceId: string): Promise<void> {
    const grantedCount = await this.prisma.referralReward.count({
      where: { referrerWorkspaceId, status: "granted" },
    });
    if (grantedCount < REFERRAL_BONUS_THRESHOLD) return;

    const claimed = await this.prisma.workspace.updateMany({
      where: { id: referrerWorkspaceId, referralBonusGrantedAt: null },
      data: { referralBonusGrantedAt: new Date() },
    });
    if (claimed.count === 0) return; // Already granted.

    // `refId` is `credit_ledger.ref_id`, `CHAR(26)` — the workspace id itself
    // fits exactly and is enough to trace the bonus lot back to its
    // workspace; `referralBonusGrantedAt`'s conditional update above is what
    // actually makes this exactly-once, not the ref id.
    await this.credits.grantLot({
      workspaceId: referrerWorkspaceId,
      source: "referral",
      tenths: REFERRAL_BONUS_TENTHS,
      reason: `Referral tier bonus — ${String(REFERRAL_BONUS_THRESHOLD)} granted referrals`,
      refId: referrerWorkspaceId,
    });

    this.logger.log({ referrerWorkspaceId }, "referral tier bonus granted");
  }
}
