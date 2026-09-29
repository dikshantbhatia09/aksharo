import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { type Env, surfaceEnabled } from "@montaj/config";
import { VIDEO_SHAPES, type VideoShape } from "@montaj/repurpose-contracts";

import { ClipApprovalGate } from "./clip-approval.gate.js";
import { ReviewNotifier, type ReviewNotice } from "./review-notifier.js";
import {
  coveredShapes,
  decide,
  mayDecide,
  mayResolve,
  pinVideos,
  pinnedShapes,
  pinsOf,
  reopenedBy,
  reviewPermissions,
  samePins,
  uncoveredShapes,
  type ReviewActor,
  type ReviewDecision,
  type VideoPins,
} from "./review-state.js";
import { generateReviewToken, hashReviewToken, tokenHint } from "./review-token.js";
import { reviewVideosOf, type ReviewVideo } from "./review-videos.js";
import {
  COMMENTS_PER_CLIP_MAX,
  EVENTS_PER_CLIP_MAX,
  MAX_LINKS_PER_RUN,
  MEMBER_VIDEO_URL_TTL_SECONDS,
  REVIEW_ERRORS,
} from "./review.constants.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, PrismaService } from "../../common/index.js";
import { DERIVED_STORE, type ObjectStore } from "../../common/storage/index.js";
import { ENV } from "../../config/config.module.js";
import { EntitlementService } from "../../workspaces/entitlement.service.js";
import { REPURPOSE_ERRORS, REPURPOSE_FLAGS } from "../repurpose.constants.js";
import { isRemoved } from "../steering.js";

import type {
  AddClipCommentInput,
  ClipCommentView,
  ClipReviewDetailView,
  ClipReviewEventView,
  ClipReviewSummaryView,
  CreateReviewLinkInput,
  CreatedReviewLinkView,
  ReviewActorView,
  ReviewDecisionInput,
  ReviewLinkView,
  ReviewVideoView,
  RunReviewView,
} from "./review.dto.js";
import type { $Enums, ClipComment, ClipReview, ClipReviewLink, Prisma } from "@prisma/client";

/**
 * Clip review (2026-10-03): the team's side, and the one writer of review
 * decisions for both the team and a client link (`ClientReviewService` calls
 * {@link record} and {@link addComment}).
 *
 * What it holds to:
 *
 *   * **One writer, compare-and-set.** A clip's `clip_reviews` row changes only
 *     `WHERE version = n`, in the transaction that appends its
 *     `clip_review_events` row, so two decisions at once cannot both win and
 *     the history never disagrees with the state. A lost race is read again
 *     and retried, twice, then answered `review/busy`.
 *   * **Decisions are pinned** to the videos they were made on
 *     (`review-state.ts`), and **a new video in a pinned shape returns the clip
 *     to pending** ({@link sync}): on every read of a run's review, on every
 *     finished export (`ReviewExportListener`), and before a client's page is
 *     built.
 *   * **Tenancy**: everything is looked up by workspace and id together.
 *   * **Audited and told**: every decision, comment and link change writes
 *     `audit_log`; decisions, comments and returns to review tell the run's
 *     creator (`ReviewNotifier`).
 */

/** The member making a request: id and live role (`WorkspaceMemberGuard` refreshes it). */
export interface MemberCaller {
  readonly userId: string;
  readonly role: $Enums.MembershipRole;
}

/** The clip a decision or comment is about, already scoped to its run and workspace. */
export interface ReviewTarget {
  readonly workspaceId: string;
  readonly runId: string;
  readonly clipId: string;
}

/** The actor columns every review table carries. */
interface ActorColumns {
  readonly actorKind: $Enums.ReviewActorKind;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly reviewLinkId: string | null;
}

function actorColumns(actor: ReviewActor): ActorColumns {
  return actor.kind === "member"
    ? { actorKind: "member", actorUserId: actor.userId, actorName: null, reviewLinkId: null }
    : { actorKind: "client", actorUserId: null, actorName: actor.name, reviewLinkId: actor.linkId };
}

class LostRace extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

/** Where a link stands at `now`. */
export function linkStatus(
  link: Pick<ClipReviewLink, "revokedAt" | "expiresAt">,
  now: number,
): ReviewLinkView["status"] {
  if (link.revokedAt !== null) return "revoked";
  return link.expiresAt.getTime() <= now ? "expired" : "live";
}

@Injectable()
export class ClipReviewService {
  private readonly logger = new Logger(ClipReviewService.name);

  /** A field so a test can set the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
    private readonly notifier: ReviewNotifier,
    private readonly gate: ClipApprovalGate,
    private readonly entitlements: EntitlementService,
    @Inject(ENV) private readonly env: Env,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Every listed clip's review, the setting, and what the caller may do. */
  async runReview(
    workspaceId: string,
    runId: string,
    caller: MemberCaller,
  ): Promise<RunReviewView> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const clipIds = await this.listedClipIds(run.id);
    await this.sync(workspaceId, clipIds);
    const [clips, needsApproval] = await Promise.all([
      this.summaries(workspaceId, run.id, clipIds),
      this.gate.required(workspaceId),
    ]);
    return {
      runId: run.id,
      needsApproval,
      permissions: reviewPermissions(caller.role),
      clips,
    };
  }

  /** One clip's review, its history and its comments. */
  async clipReview(
    workspaceId: string,
    runId: string,
    clipId: string,
    caller: MemberCaller,
  ): Promise<ClipReviewDetailView> {
    await this.assertAvailable(workspaceId);
    const target = await this.requireTarget(workspaceId, runId, clipId);
    await this.sync(workspaceId, [target.clipId]);
    const [[clip], events, comments] = await Promise.all([
      this.summaries(workspaceId, target.runId, [target.clipId]),
      this.prisma.clipReviewEvent.findMany({
        where: { clipId: target.clipId, workspaceId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: EVENTS_PER_CLIP_MAX,
      }),
      this.prisma.clipComment.findMany({
        where: { clipId: target.clipId, workspaceId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: COMMENTS_PER_CLIP_MAX,
      }),
    ]);
    const actors = await this.actorViews([
      ...events.map((event) => ({
        kind: event.actorKind,
        userId: event.actorUserId,
        name: event.actorName,
        linkId: event.reviewLinkId,
      })),
      ...comments.map((comment) => this.commentActor(comment)),
    ]);
    return {
      clip: clip as ClipReviewSummaryView,
      events: events.map((event): ClipReviewEventView => ({
        id: event.id,
        state: event.state,
        actor: actors({
          kind: event.actorKind,
          userId: event.actorUserId,
          name: event.actorName,
          linkId: event.reviewLinkId,
        }),
        note: event.note,
        reason: event.reason,
        shapes: pinnedShapes(event.videos),
        createdAt: event.createdAt.toISOString(),
      })),
      comments: comments.map((comment) => this.commentView(comment, actors, caller)),
    };
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  /**
   * A member approves, or asks for changes. Approving takes an owner or admin;
   * asking for changes, an editor (`review-state.ts`). `expect` is what the page
   * showed: a decision is never pinned to videos the person did not see.
   */
  async decideAsMember(
    workspaceId: string,
    caller: MemberCaller,
    runId: string,
    clipId: string,
    input: ReviewDecisionInput,
  ): Promise<ClipReviewSummaryView> {
    await this.assertAvailable(workspaceId);
    const target = await this.requireTarget(workspaceId, runId, clipId);
    if (!mayDecide(caller.role, input.decision)) {
      throw new AppException(
        REVIEW_ERRORS.forbidden,
        input.decision === "approved"
          ? "Only an owner or admin can approve a clip."
          : "Your role does not allow asking for changes. Leave a comment instead.",
        HttpStatus.FORBIDDEN,
      );
    }
    const videos = (await reviewVideosOf(this.prisma, [target.clipId])).get(target.clipId);
    const pins = pinVideos(videos ?? new Map());
    if (input.expect !== undefined && !samePins(input.expect, pins)) throw videoChanged();
    await this.record(target, {
      decision: input.decision,
      actor: { kind: "member", userId: caller.userId },
      videos: pins,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    const [summary] = await this.summaries(workspaceId, target.runId, [target.clipId]);
    return summary as ClipReviewSummaryView;
  }

  /**
   * Write one decision (a member's or a client's): the state, the event behind
   * it and, when it says something, the comment. Answers whether anything was
   * written: the same person repeating the same decision is one event.
   */
  async record(
    target: ReviewTarget,
    input: {
      readonly decision: ReviewDecision;
      readonly actor: ReviewActor;
      readonly videos: VideoPins;
      readonly note?: string;
      readonly ip?: string;
    },
  ): Promise<{ readonly written: boolean }> {
    const note = input.note?.trim() === "" ? undefined : input.note?.trim();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.prisma.clipReview.findFirst({
        where: { clipId: target.clipId, workspaceId: target.workspaceId },
      });
      const outcome = decide(current, {
        decision: input.decision,
        actor: input.actor,
        videos: input.videos,
        note,
      });
      if (outcome.kind === "no_video") {
        throw new AppException(
          REVIEW_ERRORS.noVideo,
          "This clip has no finished video with captions yet. Approve it once its video is made.",
          HttpStatus.CONFLICT,
        );
      }
      if (outcome.kind === "unchanged") return { written: false };

      const at = new Date(this.now());
      const eventId = ulid();
      const commentId = note === undefined ? null : ulid();
      const actor = actorColumns(input.actor);
      const videos = outcome.videos as Prisma.InputJsonObject;
      try {
        await this.prisma.$transaction(async (tx) => {
          if (current === null) {
            await tx.clipReview.create({
              data: {
                clipId: target.clipId,
                runId: target.runId,
                workspaceId: target.workspaceId,
                state: outcome.state,
                ...actor,
                videos,
                version: 1,
                decidedAt: at,
              },
            });
          } else {
            const { count } = await tx.clipReview.updateMany({
              where: { clipId: target.clipId, version: current.version },
              data: {
                state: outcome.state,
                ...actor,
                videos,
                version: current.version + 1,
                decidedAt: at,
              },
            });
            if (count === 0) throw new LostRace();
          }
          await tx.clipReviewEvent.create({
            data: {
              id: eventId,
              clipId: target.clipId,
              runId: target.runId,
              workspaceId: target.workspaceId,
              state: outcome.state,
              ...actor,
              note: note ?? null,
              videos,
              createdAt: at,
            },
          });
          if (commentId !== null && note !== undefined) {
            await tx.clipComment.create({
              data: {
                id: commentId,
                clipId: target.clipId,
                runId: target.runId,
                workspaceId: target.workspaceId,
                authorKind: actor.actorKind,
                authorUserId: actor.actorUserId,
                authorName: actor.actorName,
                reviewLinkId: actor.reviewLinkId,
                body: note,
                createdAt: at,
                updatedAt: at,
              },
            });
          }
        });
      } catch (error) {
        if (error instanceof LostRace || isUniqueViolation(error)) continue;
        throw error;
      }

      await this.audit.record({
        action: "repurpose.clip.review_decided",
        resource: "repurpose_clip",
        resourceId: target.clipId,
        workspaceId: target.workspaceId,
        ...(input.actor.kind === "member"
          ? { actorId: input.actor.userId }
          : { actorKind: "guest" }),
        ...(input.ip === undefined ? {} : { ip: input.ip }),
        data: {
          runId: target.runId,
          state: outcome.state,
          was: current?.state ?? "pending",
          videos,
          note: note !== undefined,
          ...(input.actor.kind === "client"
            ? { reviewLinkId: input.actor.linkId, name: input.actor.name }
            : {}),
        },
      });
      await this.notifier.send({
        workspaceId: target.workspaceId,
        runId: target.runId,
        clipId: target.clipId,
        verdict: outcome.state === "approved" ? "approved" : "changes",
        actor: noticeActor(input.actor),
        sourceId: eventId,
      });
      return { written: true };
    }
    throw new AppException(
      REVIEW_ERRORS.busy,
      "Someone else reviewed this clip at the same moment. Look again, then decide.",
      HttpStatus.CONFLICT,
    );
  }

  // -------------------------------------------------------------------------
  // Back to review when the video changes
  // -------------------------------------------------------------------------

  /**
   * Return every decided clip among `clipIds` whose pinned video has been
   * replaced to pending, with an event from Aksharo (`reason: video_changed`).
   * A decision that lands meanwhile wins the compare-and-set and stands.
   * Never throws: it runs inside reads and an event listener.
   */
  async sync(workspaceId: string, clipIds: readonly string[]): Promise<void> {
    if (clipIds.length === 0) return;
    try {
      const reviews = await this.prisma.clipReview.findMany({
        where: { workspaceId, clipId: { in: [...new Set(clipIds)] }, state: { not: "pending" } },
      });
      if (reviews.length === 0) return;
      const videos = await reviewVideosOf(
        this.prisma,
        reviews.map((review) => review.clipId),
      );
      for (const review of reviews) {
        const replaced = reopenedBy(review, videos.get(review.clipId) ?? new Map());
        if (replaced !== null) await this.reopen(review, replaced);
      }
    } catch (error) {
      this.logger.warn({ workspaceId, err: error }, "could not bring changed clips back to review");
    }
  }

  /** A finished export: when it is a clip shape's video, that clip's decision is checked. */
  async syncForExport(workspaceId: string, exportId: string): Promise<void> {
    try {
      const row = await this.prisma.export.findFirst({
        where: { id: exportId, workspaceId },
        select: { projectId: true, kind: true },
      });
      if (row === null || row.kind !== "mp4") return;
      const variant = await this.prisma.clipVariant.findUnique({
        where: { projectId: row.projectId },
        select: { clipId: true },
      });
      if (variant === null) return;
      await this.sync(workspaceId, [variant.clipId]);
    } catch (error) {
      this.logger.warn({ exportId, err: error }, "could not check a finished export's review");
    }
  }

  private async reopen(review: ClipReview, replaced: readonly VideoShape[]): Promise<void> {
    const at = new Date(this.now());
    const eventId = ulid();
    const reopened = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.clipReview.updateMany({
        where: { clipId: review.clipId, version: review.version },
        data: {
          state: "pending",
          actorKind: "system",
          actorUserId: null,
          actorName: null,
          reviewLinkId: null,
          videos: {},
          version: review.version + 1,
          decidedAt: at,
        },
      });
      if (count === 0) return false;
      await tx.clipReviewEvent.create({
        data: {
          id: eventId,
          clipId: review.clipId,
          runId: review.runId,
          workspaceId: review.workspaceId,
          state: "pending",
          actorKind: "system",
          reason: "video_changed",
          videos: {},
          createdAt: at,
        },
      });
      return true;
    });
    if (!reopened) return;
    this.logger.log(
      { runId: review.runId, clipId: review.clipId, was: review.state, shapes: replaced },
      "a clip's video changed after its review; back to pending",
    );
    await this.audit.record({
      action: "repurpose.clip.review_reopened",
      resource: "repurpose_clip",
      resourceId: review.clipId,
      actorKind: "system",
      workspaceId: review.workspaceId,
      data: { runId: review.runId, was: review.state, shapes: [...replaced] },
    });
    await this.notifier.send({
      workspaceId: review.workspaceId,
      runId: review.runId,
      clipId: review.clipId,
      verdict: "reopened",
      actor: { kind: "system" },
      sourceId: eventId,
    });
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  /** A member's comment. Everyone may comment, viewers included (`review-state.ts`). */
  async addMemberComment(
    workspaceId: string,
    caller: MemberCaller,
    runId: string,
    clipId: string,
    input: AddClipCommentInput,
  ): Promise<ClipCommentView> {
    await this.assertAvailable(workspaceId);
    const target = await this.requireTarget(workspaceId, runId, clipId);
    const comment = await this.addComment(target, { kind: "member", userId: caller.userId }, input);
    const actors = await this.actorViews([this.commentActor(comment)]);
    return this.commentView(comment, actors, caller);
  }

  /** Write one comment (a member's or a client's), audit it and tell the run's creator. */
  async addComment(
    target: ReviewTarget,
    author: ReviewActor,
    input: { readonly body: string; readonly atMs?: number | undefined; readonly ip?: string },
  ): Promise<ClipComment> {
    const actor = actorColumns(author);
    const at = new Date(this.now());
    const comment = await this.prisma.clipComment.create({
      data: {
        id: ulid(),
        clipId: target.clipId,
        runId: target.runId,
        workspaceId: target.workspaceId,
        authorKind: actor.actorKind,
        authorUserId: actor.actorUserId,
        authorName: actor.actorName,
        reviewLinkId: actor.reviewLinkId,
        body: input.body.trim(),
        atMs: input.atMs ?? null,
        createdAt: at,
        updatedAt: at,
      },
    });
    await this.audit.record({
      action: "repurpose.clip.comment_added",
      resource: "clip_comment",
      resourceId: comment.id,
      workspaceId: target.workspaceId,
      ...(author.kind === "member" ? { actorId: author.userId } : { actorKind: "guest" }),
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      data: {
        runId: target.runId,
        clipId: target.clipId,
        atMs: comment.atMs,
        ...(author.kind === "client" ? { reviewLinkId: author.linkId, name: author.name } : {}),
      },
    });
    await this.notifier.send({
      workspaceId: target.workspaceId,
      runId: target.runId,
      clipId: target.clipId,
      verdict: "comment",
      actor: noticeActor(author),
      sourceId: comment.id,
    });
    return comment;
  }

  /** Resolve or reopen a comment: editors and up any, anyone their own. */
  async resolveComment(
    workspaceId: string,
    caller: MemberCaller,
    runId: string,
    clipId: string,
    commentId: string,
    resolved: boolean,
  ): Promise<ClipCommentView> {
    await this.assertAvailable(workspaceId);
    const target = await this.requireTarget(workspaceId, runId, clipId);
    const comment = await this.prisma.clipComment.findFirst({
      where: { id: commentId, clipId: target.clipId, workspaceId },
    });
    if (comment === null) {
      throw new AppException(
        REVIEW_ERRORS.commentNotFound,
        "We could not find that comment.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (!mayResolve(caller.role, comment, caller.userId)) {
      throw new AppException(
        REVIEW_ERRORS.forbidden,
        "You can resolve your own comments. An editor resolves the rest.",
        HttpStatus.FORBIDDEN,
      );
    }
    let row = comment;
    if ((comment.resolvedAt !== null) !== resolved) {
      row = await this.prisma.clipComment.update({
        where: { id: comment.id },
        data: resolved
          ? { resolvedAt: new Date(this.now()), resolvedBy: caller.userId }
          : { resolvedAt: null, resolvedBy: null },
      });
      await this.audit.record({
        action: resolved ? "repurpose.clip.comment_resolved" : "repurpose.clip.comment_reopened",
        resource: "clip_comment",
        resourceId: comment.id,
        actorId: caller.userId,
        workspaceId,
        data: { runId: target.runId, clipId: target.clipId },
      });
    }
    const actors = await this.actorViews([this.commentActor(row)]);
    return this.commentView(row, actors, caller);
  }

  // -------------------------------------------------------------------------
  // Client links
  // -------------------------------------------------------------------------

  /**
   * Make a link a client reviews this run's clips through. An owner or admin
   * only (the controller's `@Roles("admin")`): a client's approval counts, so a
   * link is approval handed to someone else. The token is in the answer once,
   * as the link, and never stored.
   */
  async createLink(
    workspaceId: string,
    caller: MemberCaller,
    runId: string,
    input: CreateReviewLinkInput,
  ): Promise<CreatedReviewLinkView> {
    await this.assertAvailable(workspaceId);
    this.assertPublicLinks();
    const run = await this.requireRun(workspaceId, runId);
    const now = this.now();
    const live = await this.prisma.clipReviewLink.count({
      where: { workspaceId, runId: run.id, revokedAt: null, expiresAt: { gt: new Date(now) } },
    });
    if (live >= MAX_LINKS_PER_RUN) {
      throw new AppException(
        REVIEW_ERRORS.tooManyLinks,
        `This run already has ${String(MAX_LINKS_PER_RUN)} review links. Revoke one you no longer need first.`,
        HttpStatus.CONFLICT,
      );
    }
    const token = generateReviewToken();
    const link = await this.prisma.clipReviewLink.create({
      data: {
        id: ulid(),
        workspaceId,
        runId: run.id,
        tokenHash: hashReviewToken(token),
        tokenHint: tokenHint(token),
        label: input.label ?? null,
        requireName: input.requireName,
        expiresAt: new Date(now + input.expiresInDays * 24 * 60 * 60_000),
        createdBy: caller.userId,
        createdAt: new Date(now),
      },
    });
    await this.audit.record({
      action: "repurpose.review_link.created",
      resource: "clip_review_link",
      resourceId: link.id,
      actorId: caller.userId,
      workspaceId,
      data: {
        runId: run.id,
        expiresAt: link.expiresAt.toISOString(),
        requireName: link.requireName,
        hint: link.tokenHint,
      },
    });
    return {
      ...this.linkView(link, { decisions: 0, comments: 0 }),
      url: new URL(`/share/review/${token}`, this.env.WEB_ORIGIN).toString(),
    };
  }

  async listLinks(workspaceId: string, runId: string): Promise<ReviewLinkView[]> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const links = await this.prisma.clipReviewLink.findMany({
      where: { workspaceId, runId: run.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    if (links.length === 0) return [];
    const ids = links.map((link) => link.id);
    const [decisions, comments] = await Promise.all([
      this.prisma.clipReviewEvent.groupBy({
        by: ["reviewLinkId"],
        where: { workspaceId, reviewLinkId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.clipComment.groupBy({
        by: ["reviewLinkId"],
        where: { workspaceId, reviewLinkId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    const count = (
      rows: readonly { reviewLinkId: string | null; _count: { _all: number } }[],
      id: string,
    ): number => rows.find((row) => row.reviewLinkId === id)?._count._all ?? 0;
    return links.map((link) =>
      this.linkView(link, {
        decisions: count(decisions, link.id),
        comments: count(comments, link.id),
      }),
    );
  }

  /** Revoke a link: it stops opening at once. Editors and up; it only takes access away. */
  async revokeLink(
    workspaceId: string,
    caller: MemberCaller,
    runId: string,
    linkId: string,
  ): Promise<ReviewLinkView> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const link = await this.prisma.clipReviewLink.findFirst({
      where: { id: linkId, runId: run.id, workspaceId },
    });
    if (link === null) {
      throw new AppException(
        REVIEW_ERRORS.linkNotFound,
        "We could not find that review link.",
        HttpStatus.NOT_FOUND,
      );
    }
    let row = link;
    if (link.revokedAt === null) {
      const at = new Date(this.now());
      await this.prisma.clipReviewLink.updateMany({
        where: { id: link.id, revokedAt: null },
        data: { revokedAt: at, revokedBy: caller.userId },
      });
      row = { ...link, revokedAt: at, revokedBy: caller.userId };
      await this.audit.record({
        action: "repurpose.review_link.revoked",
        resource: "clip_review_link",
        resourceId: link.id,
        actorId: caller.userId,
        workspaceId,
        data: { runId: run.id, hint: link.tokenHint },
      });
    }
    return this.linkView(row, { decisions: 0, comments: 0 });
  }

  // -------------------------------------------------------------------------
  // Shared checks (also used by the client side)
  // -------------------------------------------------------------------------

  /**
   * The same rule as the rest of the clips surface: `FEATURE_FLAGS_JSON` wins,
   * else the workspace's entitlement. 404 while it is off.
   */
  async assertAvailable(workspaceId: string): Promise<void> {
    const override = this.env.FEATURE_FLAGS_JSON[REPURPOSE_FLAGS.flow];
    const enabled =
      typeof override === "boolean"
        ? override
        : (
            (await this.entitlements.forWorkspace(workspaceId)).entitlements.flags as
              Record<string, boolean> | undefined
          )?.[REPURPOSE_FLAGS.flow] === true;
    if (enabled) return;
    throw new AppException(
      REPURPOSE_ERRORS.disabled,
      "This feature is not available yet.",
      HttpStatus.NOT_FOUND,
    );
  }

  /** Client links live on the public share surface (`shares.public`): 404 while it is off. */
  assertPublicLinks(): void {
    if (surfaceEnabled("publicShares", this.env.FEATURE_FLAGS_JSON)) return;
    throw new AppException(
      REPURPOSE_ERRORS.disabled,
      "Sharing clips for review is not available yet.",
      HttpStatus.NOT_FOUND,
    );
  }

  /** Workspace and id together - never "find by id, then check". */
  async requireRun(workspaceId: string, runId: string): Promise<{ readonly id: string }> {
    const run = await this.prisma.repurposeRun.findFirst({
      where: { id: runId, workspaceId },
      select: { id: true },
    });
    if (run === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that video project.",
        HttpStatus.NOT_FOUND,
      );
    }
    return run;
  }

  /** A clip of the run that is listed on its page: not one whose moment was removed. */
  async requireTarget(workspaceId: string, runId: string, clipId: string): Promise<ReviewTarget> {
    const run = await this.requireRun(workspaceId, runId);
    const clip = await this.prisma.repurposeClip.findFirst({
      where: { id: clipId, runId: run.id, run: { workspaceId } },
      select: { id: true, candidate: { select: { state: true } } },
    });
    if (clip === null || isRemoved(clip.candidate)) {
      throw new AppException(
        REVIEW_ERRORS.clipNotFound,
        "We could not find that clip.",
        HttpStatus.NOT_FOUND,
      );
    }
    return { workspaceId, runId: run.id, clipId: clip.id };
  }

  /** The clips a run's page lists, in order. */
  async listedClipIds(runId: string): Promise<string[]> {
    const clips = await this.prisma.repurposeClip.findMany({
      where: { runId },
      select: { id: true, candidate: { select: { state: true } } },
      orderBy: { createdAt: "asc" },
    });
    return clips.filter((clip) => !isRemoved(clip.candidate)).map((clip) => clip.id);
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private async summaries(
    workspaceId: string,
    runId: string,
    clipIds: readonly string[],
  ): Promise<ClipReviewSummaryView[]> {
    if (clipIds.length === 0) return [];
    const ids = [...clipIds];
    const [reviews, videos, totals, open] = await Promise.all([
      this.prisma.clipReview.findMany({ where: { workspaceId, clipId: { in: ids } } }),
      reviewVideosOf(this.prisma, ids),
      this.prisma.clipComment.groupBy({
        by: ["clipId"],
        where: { workspaceId, runId, clipId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.clipComment.groupBy({
        by: ["clipId"],
        where: { workspaceId, runId, clipId: { in: ids }, resolvedAt: null },
        _count: { _all: true },
      }),
    ]);
    const byClip = new Map(reviews.map((review) => [review.clipId, review]));
    const actors = await this.actorViews(
      reviews.map((review) => ({
        kind: review.actorKind,
        userId: review.actorUserId,
        name: review.actorName,
        linkId: review.reviewLinkId,
      })),
    );
    const views: ClipReviewSummaryView[] = [];
    for (const clipId of ids) {
      const review = byClip.get(clipId) ?? null;
      const shapes = videos.get(clipId) ?? new Map<VideoShape, ReviewVideo>();
      const state = review?.state ?? "pending";
      const pins = state === "pending" ? {} : pinsOf(review?.videos);
      views.push({
        clipId,
        state,
        decidedBy:
          review === null
            ? null
            : actors({
                kind: review.actorKind,
                userId: review.actorUserId,
                name: review.actorName,
                linkId: review.reviewLinkId,
              }),
        decidedAt: review === null ? null : review.decidedAt.toISOString(),
        reason:
          review !== null && review.state === "pending" && review.actorKind === "system"
            ? "video_changed"
            : null,
        covered: state === "pending" ? [] : coveredShapes(pins, shapes),
        uncovered: state === "pending" ? [] : uncoveredShapes(pins, shapes),
        videos: pinVideos(shapes),
        video: await this.videoView(shapes),
        comments: {
          total: totals.find((row) => row.clipId === clipId)?._count._all ?? 0,
          open: open.find((row) => row.clipId === clipId)?._count._all ?? 0,
        },
      });
    }
    return views;
  }

  /** The 9:16 video, else the first shape there is, signed for the run page's hour. */
  private async videoView(
    shapes: ReadonlyMap<VideoShape, ReviewVideo>,
  ): Promise<ReviewVideoView | null> {
    const shape = VIDEO_SHAPES.find((entry) => shapes.has(entry));
    const video = shape === undefined ? undefined : shapes.get(shape);
    if (shape === undefined || video === undefined) return null;
    let url: string | null = null;
    try {
      url = await this.derived.presignGet(video.storageKey, MEMBER_VIDEO_URL_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ exportId: video.exportId, err: error }, "could not sign a review video");
    }
    return { shape, exportId: video.exportId, url, durationMs: video.durationMs };
  }

  private commentActor(comment: ClipComment): ActorRef {
    return {
      kind: comment.authorKind,
      userId: comment.authorUserId,
      name: comment.authorName,
      linkId: comment.reviewLinkId,
    };
  }

  private commentView(
    comment: ClipComment,
    actors: ActorLookup,
    caller: MemberCaller,
  ): ClipCommentView {
    return {
      id: comment.id,
      clipId: comment.clipId,
      author: actors(this.commentActor(comment)),
      body: comment.body,
      atMs: comment.atMs,
      resolvedAt: iso(comment.resolvedAt),
      createdAt: comment.createdAt.toISOString(),
      canResolve: mayResolve(caller.role, comment, caller.userId),
    };
  }

  /**
   * Names for the people and links behind a set of rows, looked up once: a
   * member's name (or the part of their address before the `@`), a client's own
   * name, and a link's hint and label.
   */
  private async actorViews(entries: readonly ActorRef[]): Promise<ActorLookup> {
    const userIds = [
      ...new Set(entries.flatMap((entry) => (entry.userId === null ? [] : [entry.userId]))),
    ];
    const linkIds = [
      ...new Set(entries.flatMap((entry) => (entry.linkId === null ? [] : [entry.linkId]))),
    ];
    const [users, links] = await Promise.all([
      userIds.length === 0
        ? []
        : this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
          }),
      linkIds.length === 0
        ? []
        : this.prisma.clipReviewLink.findMany({
            where: { id: { in: linkIds } },
            select: { id: true, tokenHint: true, label: true },
          }),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const linkById = new Map(links.map((link) => [link.id, link]));
    return (entry) => {
      const link = entry.linkId === null ? undefined : linkById.get(entry.linkId);
      const user = entry.userId === null ? undefined : userById.get(entry.userId);
      const memberName =
        user === undefined
          ? null
          : user.name !== null && user.name.trim() !== ""
            ? user.name.trim()
            : (user.email.split("@")[0] ?? null);
      return {
        kind: entry.kind,
        name: entry.kind === "member" ? memberName : entry.kind === "client" ? entry.name : null,
        userId: entry.kind === "member" ? entry.userId : null,
        link: link === undefined ? null : { id: link.id, hint: link.tokenHint, label: link.label },
      };
    };
  }

  private linkView(
    link: ClipReviewLink,
    counts: { readonly decisions: number; readonly comments: number },
  ): ReviewLinkView {
    return {
      id: link.id,
      runId: link.runId,
      hint: link.tokenHint,
      label: link.label,
      requireName: link.requireName,
      expiresAt: link.expiresAt.toISOString(),
      revokedAt: iso(link.revokedAt),
      status: linkStatus(link, this.now()),
      createdBy: link.createdBy,
      createdAt: link.createdAt.toISOString(),
      visits: link.viewCount,
      lastVisitAt: iso(link.lastViewedAt),
      decisions: counts.decisions,
      comments: counts.comments,
    };
  }
}

/** Who is behind one row: the columns every review table carries, read back. */
interface ActorRef {
  readonly kind: $Enums.ReviewActorKind;
  readonly userId: string | null;
  readonly name: string | null;
  readonly linkId: string | null;
}

type ActorLookup = (entry: ActorRef) => ReviewActorView;

function noticeActor(actor: ReviewActor): ReviewNotice["actor"] {
  return actor.kind === "member"
    ? { kind: "member", userId: actor.userId }
    : { kind: "client", name: actor.name };
}

function videoChanged(): AppException {
  return new AppException(
    REVIEW_ERRORS.videoChanged,
    "This clip's video changed while you were looking. Watch the new version, then decide.",
    HttpStatus.CONFLICT,
  );
}
