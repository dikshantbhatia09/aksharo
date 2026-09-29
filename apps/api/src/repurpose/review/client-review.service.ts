import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import { ClipCopySchema, type VideoShape } from "@montaj/repurpose-contracts";

import { ClipReviewService } from "./clip-review.service.js";
import { pinVideos, pinsOf } from "./review-state.js";
import { hashReviewToken, looksLikeReviewToken } from "./review-token.js";
import { reviewVideosOf, type ReviewVideo } from "./review-videos.js";
import {
  CLIENT_SHAPE,
  LINK_WRITE_BUCKET,
  PUBLIC_VIDEO_URL_TTL_SECONDS,
  REVIEW_ERRORS,
  VISIT_GAP_MS,
} from "./review.constants.js";
import { AppException, ERROR_CODES, PrismaService, RateLimitService } from "../../common/index.js";
import { DERIVED_STORE, type ObjectStore } from "../../common/storage/index.js";
import { cleanSourceTitle } from "../repurpose.projection.js";
import { isRemoved } from "../steering.js";

import type {
  ClientCommentInput,
  ClientDecisionInput,
  PublicClipView,
  PublicReviewView,
} from "./review.dto.js";
import type { ClipReviewLink } from "@prisma/client";

/**
 * The client's side of clip review (2026-10-03): the page a link opens, and the
 * approvals, requests for changes and comments made on it, by someone with no
 * account.
 *
 * **What a link reaches** is one run's clips that have a captioned 9:16 video:
 * their titles and words, that video (signed for {@link PUBLIC_VIDEO_URL_TTL_SECONDS},
 * never a download, never the original, the clean cut or another shape), and
 * the decisions and comments made through THIS link. Nothing of the workspace
 * (not its name, members, other runs or the team's own comments) and no
 * storage key is in any answer; the signed URL's path names the export's
 * object, as every signed URL in the product does.
 *
 * **What a client's word counts as**: a review event from the link ("Client:
 * <name>"), never a member. Their approval is an approval - which is why only an
 * owner or admin can make a link - pinned to the 9:16 video they watched.
 *
 * **Refusals look alike**: an unknown token, a malformed one and a clip that is
 * not on the page all answer 404; a revoked link 410 `review/link_revoked`, an
 * expired one 410 `review/link_expired`, so the page can say which.
 */
@Injectable()
export class ClientReviewService {
  private readonly logger = new Logger(ClientReviewService.name);

  /** A field so a test can set the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly reviews: ClipReviewService,
    private readonly limiter: RateLimitService,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  /** The page: the video's title and the clips ready to review. Counts a visit. */
  async open(token: string): Promise<PublicReviewView> {
    const link = await this.resolveLink(token);
    await this.recordVisit(link);
    const run = await this.prisma.repurposeRun.findFirst({
      where: { id: link.runId, workspaceId: link.workspaceId },
      select: { sourceTitle: true, sourceProject: { select: { title: true } } },
    });
    const clips = await this.clipsOnPage(link);
    return {
      title:
        cleanSourceTitle(run?.sourceTitle) ??
        cleanSourceTitle(run?.sourceProject.title) ??
        "Your clips",
      requireName: link.requireName,
      expiresAt: link.expiresAt.toISOString(),
      clips: await this.clipViews(link, clips),
    };
  }

  /** Approve, or ask for changes, as "Client: <name>". */
  async decide(
    token: string,
    clipId: string,
    input: ClientDecisionInput,
    context: { readonly ip?: string } = {},
  ): Promise<PublicClipView> {
    const link = await this.resolveLink(token);
    const name = this.nameFor(link, input.name);
    await this.consumeLinkWrite(link);
    const clip = await this.clipOnPage(link, clipId);
    const video = clip.videos.get(CLIENT_SHAPE);
    if (video === undefined) throw clipNotFound();
    if (input.expect !== undefined && input.expect !== video.exportId) {
      throw new AppException(
        REVIEW_ERRORS.videoChanged,
        "This clip was updated while you were watching. Watch the new version, then decide.",
        HttpStatus.CONFLICT,
      );
    }
    await this.reviews.record(
      { workspaceId: link.workspaceId, runId: link.runId, clipId: clip.id },
      {
        decision: input.decision,
        actor: { kind: "client", linkId: link.id, name },
        // What they watched, and only that: the 9:16 video.
        videos: pinVideos(clip.videos, [CLIENT_SHAPE]),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(context.ip === undefined ? {} : { ip: context.ip }),
      },
    );
    const [view] = await this.clipViews(link, [clip]);
    return view as PublicClipView;
  }

  /** A comment, optionally at a moment in the clip. */
  async comment(
    token: string,
    clipId: string,
    input: ClientCommentInput,
    context: { readonly ip?: string } = {},
  ): Promise<PublicClipView["comments"][number]> {
    const link = await this.resolveLink(token);
    const name = this.nameFor(link, input.name);
    await this.consumeLinkWrite(link);
    const clip = await this.clipOnPage(link, clipId);
    const comment = await this.reviews.addComment(
      { workspaceId: link.workspaceId, runId: link.runId, clipId: clip.id },
      { kind: "client", linkId: link.id, name },
      {
        body: input.body,
        atMs: input.atMs,
        ...(context.ip === undefined ? {} : { ip: context.ip }),
      },
    );
    return {
      id: comment.id,
      name: comment.authorName,
      body: comment.body,
      atMs: comment.atMs,
      createdAt: comment.createdAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // The link
  // -------------------------------------------------------------------------

  /**
   * The link behind a token: known, not revoked, not expired, and on a
   * workspace where the clips surface is on. Looked up by the token's hash.
   */
  async resolveLink(token: string): Promise<ClipReviewLink> {
    if (!looksLikeReviewToken(token)) throw linkNotFound();
    const link = await this.prisma.clipReviewLink.findUnique({
      where: { tokenHash: hashReviewToken(token) },
    });
    if (link === null) throw linkNotFound();
    if (link.revokedAt !== null) {
      throw new AppException(
        REVIEW_ERRORS.linkRevoked,
        "This review link was turned off by the people who sent it.",
        HttpStatus.GONE,
      );
    }
    if (link.expiresAt.getTime() <= this.now()) {
      throw new AppException(
        REVIEW_ERRORS.linkExpired,
        "This review link has expired.",
        HttpStatus.GONE,
      );
    }
    // A deleted workspace's links reach nothing, and neither do a workspace's
    // whose clips surface is off.
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: link.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (workspace === null) throw linkNotFound();
    try {
      await this.reviews.assertAvailable(link.workspaceId);
    } catch {
      throw linkNotFound();
    }
    return link;
  }

  private nameFor(link: ClipReviewLink, name: string | undefined): string | null {
    if (name !== undefined && name !== "") return name;
    if (link.requireName) {
      throw new AppException(
        REVIEW_ERRORS.nameRequired,
        "Add your name first, so the team knows who this is from.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return null;
  }

  /** One bucket per link, whatever address a write comes from. */
  private async consumeLinkWrite(link: ClipReviewLink): Promise<void> {
    const verdict = await this.limiter.consume(LINK_WRITE_BUCKET, link.id);
    if (verdict.allowed) return;
    throw new AppException(
      ERROR_CODES.rateLimited,
      "That is a lot of reviewing at once. Wait a few minutes and try again.",
      HttpStatus.TOO_MANY_REQUESTS,
      { bucket: LINK_WRITE_BUCKET.name, retryAfterSec: verdict.retryAfterSec },
    );
  }

  /** A page load: counted as a visit when the last one was a while ago. Best effort. */
  private async recordVisit(link: ClipReviewLink): Promise<void> {
    const now = this.now();
    const newVisit =
      link.lastViewedAt === null || now - link.lastViewedAt.getTime() >= VISIT_GAP_MS;
    try {
      await this.prisma.clipReviewLink.update({
        where: { id: link.id },
        data: {
          lastViewedAt: new Date(now),
          ...(newVisit ? { viewCount: { increment: 1 } } : {}),
        },
      });
    } catch (error) {
      this.logger.warn({ linkId: link.id, err: error }, "could not count a review link visit");
    }
  }

  // -------------------------------------------------------------------------
  // The clips
  // -------------------------------------------------------------------------

  /**
   * The run's clips a client sees: listed on the run (not removed), with a
   * captioned 9:16 video, in the order their moments come in the video. Any
   * decision a new video has made stale is sent back to pending first, so
   * "changed since you reviewed it" is true when the page says it.
   */
  private async clipsOnPage(link: ClipReviewLink): Promise<PageClip[]> {
    const rows = await this.prisma.repurposeClip.findMany({
      where: { runId: link.runId, run: { workspaceId: link.workspaceId } },
      select: {
        id: true,
        title: true,
        copy: true,
        mezzanineDurationMs: true,
        candidate: { select: { state: true, startMs: true } },
      },
    });
    const listed = rows
      .filter((row) => !isRemoved(row.candidate))
      .sort((a, b) => a.candidate.startMs - b.candidate.startMs);
    await this.reviews.sync(
      link.workspaceId,
      listed.map((row) => row.id),
    );
    const videos = await reviewVideosOf(
      this.prisma,
      listed.map((row) => row.id),
    );
    return listed.flatMap((row) => {
      const shapes = videos.get(row.id);
      if (shapes?.get(CLIENT_SHAPE) === undefined) return [];
      return [
        {
          id: row.id,
          title: row.title,
          copy: row.copy,
          durationMs: row.mezzanineDurationMs,
          videos: shapes,
        },
      ];
    });
  }

  private async clipOnPage(link: ClipReviewLink, clipId: string): Promise<PageClip> {
    const clip = (await this.clipsOnPage(link)).find((entry) => entry.id === clipId);
    if (clip === undefined) throw clipNotFound();
    return clip;
  }

  private async clipViews(
    link: ClipReviewLink,
    clips: readonly PageClip[],
  ): Promise<PublicClipView[]> {
    if (clips.length === 0) return [];
    const ids = clips.map((clip) => clip.id);
    const [events, comments] = await Promise.all([
      this.prisma.clipReviewEvent.findMany({
        where: {
          reviewLinkId: link.id,
          workspaceId: link.workspaceId,
          clipId: { in: ids },
          state: { not: "pending" },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      this.prisma.clipComment.findMany({
        where: { reviewLinkId: link.id, workspaceId: link.workspaceId, clipId: { in: ids } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);

    const views: PublicClipView[] = [];
    for (const clip of clips) {
      const video = clip.videos.get(CLIENT_SHAPE) as ReviewVideo;
      let url: string;
      try {
        url = await this.derived.presignGet(video.storageKey, PUBLIC_VIDEO_URL_TTL_SECONDS);
      } catch (error) {
        this.logger.warn({ clipId: clip.id, err: error }, "could not sign a review video");
        continue;
      }
      const copy = ClipCopySchema.safeParse(clip.copy);
      const words = copy.success ? copy.data : null;
      const mine = events.find((event) => event.clipId === clip.id);
      views.push({
        id: clip.id,
        title: clip.title,
        hook: nonEmpty(words?.hook),
        description: nonEmpty(words?.description) ?? nonEmpty(words?.summary),
        hashtags: words?.hashtags ?? [],
        durationMs: video.durationMs ?? clip.durationMs,
        video: { exportId: video.exportId, url, durationMs: video.durationMs },
        yourDecision:
          mine === undefined || mine.state === "pending"
            ? null
            : {
                state: mine.state,
                at: mine.createdAt.toISOString(),
                name: mine.actorName,
                changedSince: pinsOf(mine.videos)["9:16"] !== video.exportId,
              },
        comments: comments
          .filter((comment) => comment.clipId === clip.id)
          .map((comment) => ({
            id: comment.id,
            name: comment.authorName,
            body: comment.body,
            atMs: comment.atMs,
            createdAt: comment.createdAt.toISOString(),
          })),
      });
    }
    return views;
  }
}

/** One clip on the page, with its review videos. */
interface PageClip {
  readonly id: string;
  readonly title: string;
  readonly copy: unknown;
  readonly durationMs: number | null;
  readonly videos: ReadonlyMap<VideoShape, ReviewVideo>;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value.trim();
}

function linkNotFound(): AppException {
  return new AppException(
    REVIEW_ERRORS.linkNotFound,
    "This review link does not exist.",
    HttpStatus.NOT_FOUND,
  );
}

function clipNotFound(): AppException {
  return new AppException(
    REVIEW_ERRORS.clipNotFound,
    "That clip is not on this review page.",
    HttpStatus.NOT_FOUND,
  );
}
