import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import {
  cleanCutsOf,
  dubFilesOf,
  episodePackOf,
  runClipsOf,
  type RunClipRow,
} from "./clip-files.reader.js";
import {
  fileStem,
  planGuestClip,
  shapeSize,
  type DubFiles,
  type GuestClipPlan,
  type ShapeFiles,
} from "./guest-files.js";
import {
  GUEST_ERRORS,
  GUEST_LINK_DOWNLOAD_BUCKET,
  GUEST_URL_TTL_SECONDS,
} from "./guest.constants.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, ERROR_CODES, PrismaService, RateLimitService } from "../../common/index.js";
import {
  DERIVED_STORE,
  keyBelongsToWorkspace,
  type ObjectStore,
} from "../../common/storage/index.js";
import { cleanSourceTitle } from "../repurpose.projection.js";
import { ClipApprovalGate } from "../review/clip-approval.gate.js";
import { ClipReviewService } from "../review/clip-review.service.js";
import { hashReviewToken, looksLikeReviewToken } from "../review/review-token.js";
import { reviewVideosOf } from "../review/review-videos.js";
import { VISIT_GAP_MS } from "../review/review.constants.js";

import type {
  GuestClipView,
  GuestDownloadInput,
  GuestPageView,
  GuestVideoView,
} from "./guest.dto.js";
import type { ClipGuestLink } from "@prisma/client";

/**
 * The guest's page (2026-10-05): the clips a podcaster shared with their guest,
 * for someone with the link and no account - usually on a phone.
 *
 * **What a link reaches** is the clips it names (or every clip of its run),
 * as the run's page lists them - never a clip of another run, never one the
 * team removed - and of each only finished files (`guest-files.ts` decides
 * which): the captioned video per shape, the clean cut, the clip's images, its
 * words to post, and its dubbed versions when the link includes them; plus the
 * run's title and the posts its episode text wrote. Nothing of the workspace
 * (its name, members, other runs, reviews or comments) and no storage key is
 * in any answer; a signed URL's path names the object, as every signed URL in
 * the product does.
 *
 * **Every URL is signed on the page view** for {@link GUEST_URL_TTL_SECONDS},
 * downloads with the file's name, and only for a key inside the link's own
 * workspace (`keyBelongsToWorkspace`, before every signature). Downloads are
 * counted when the page says one started (`countDownload`), and audited.
 *
 * **The token rules are the review links'**: looked up by its SHA-256, a
 * malformed or unknown token answers 404 like a missing one, a revoked link
 * 410 `guest/link_revoked`, an expired one 410 `guest/link_expired`, and a
 * link on a deleted workspace or one whose clips surface is off reaches
 * nothing (404).
 */
@Injectable()
export class GuestPageService {
  private readonly logger = new Logger(GuestPageService.name);

  /** A field so a test can set the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly reviews: ClipReviewService,
    private readonly gate: ClipApprovalGate,
    private readonly audit: CommonAuditService,
    private readonly limiter: RateLimitService,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  /** The page: the video's title, the shared clips' files and words. Counts a visit. */
  async open(token: string): Promise<GuestPageView> {
    const link = await this.resolveLink(token);
    await this.recordVisit(link);
    const run = await this.prisma.repurposeRun.findFirst({
      where: { id: link.runId, workspaceId: link.workspaceId },
      select: {
        sourceTitle: true,
        sourceProjectId: true,
        sourceProject: { select: { title: true } },
      },
    });
    if (run === null) throw linkNotFound();

    const shared = await this.sharedClips(link);
    const plans = await this.plansOf(link, shared);
    const clips: GuestClipView[] = [];
    let comingSoon = 0;
    for (const plan of plans) {
      const view = plan === null ? null : await this.signed(link, plan);
      if (view === null) comingSoon += 1;
      else clips.push(view);
    }
    return {
      title:
        cleanSourceTitle(run.sourceTitle) ??
        cleanSourceTitle(run.sourceProject.title) ??
        "Your clips",
      guestName: link.guestName,
      expiresAt: link.expiresAt.toISOString(),
      clips,
      comingSoon,
      episode: await this.episodeOf(link, run.sourceProjectId),
    };
  }

  /**
   * A download the page started, counted on the link and audited as the
   * guest's. Only for a clip on this link's page; the file itself was signed
   * by the page view, so a refusal here never stops a download.
   */
  async countDownload(
    token: string,
    input: GuestDownloadInput,
    context: { readonly ip?: string } = {},
  ): Promise<void> {
    const link = await this.resolveLink(token);
    const shared = await this.sharedClips(link);
    if (!shared.some((clip) => clip.id === input.clipId)) {
      throw new AppException(
        GUEST_ERRORS.clipNotFound,
        "That clip is not on this page.",
        HttpStatus.NOT_FOUND,
      );
    }
    const verdict = await this.limiter.consume(GUEST_LINK_DOWNLOAD_BUCKET, link.id);
    if (!verdict.allowed) {
      throw new AppException(
        ERROR_CODES.rateLimited,
        "That is a lot of downloading at once. Wait a few minutes and try again.",
        HttpStatus.TOO_MANY_REQUESTS,
        { bucket: GUEST_LINK_DOWNLOAD_BUCKET.name, retryAfterSec: verdict.retryAfterSec },
      );
    }
    const at = new Date(this.now());
    await this.prisma.clipGuestLink.update({
      where: { id: link.id },
      data: { downloadCount: { increment: 1 }, lastDownloadedAt: at },
    });
    await this.audit.record({
      action: "repurpose.guest_link.downloaded",
      resource: "clip_guest_link",
      resourceId: link.id,
      actorKind: "guest",
      workspaceId: link.workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: {
        runId: link.runId,
        clipId: input.clipId,
        file: input.file,
        ...(input.shape === undefined ? {} : { shape: input.shape }),
        ...(input.image === undefined ? {} : { image: input.image }),
        ...(input.language === undefined ? {} : { language: input.language }),
      },
    });
  }

  // -------------------------------------------------------------------------
  // The link
  // -------------------------------------------------------------------------

  /**
   * The link behind a token: known, not revoked, not expired, and on a
   * workspace that exists and has the clips surface on. Looked up by the
   * token's hash; a string that cannot be a token costs no query.
   */
  async resolveLink(token: string): Promise<ClipGuestLink> {
    if (!looksLikeReviewToken(token)) throw linkNotFound();
    const link = await this.prisma.clipGuestLink.findUnique({
      where: { tokenHash: hashReviewToken(token) },
    });
    if (link === null) throw linkNotFound();
    if (link.revokedAt !== null) {
      throw new AppException(
        GUEST_ERRORS.linkRevoked,
        "This link was turned off by the people who sent it.",
        HttpStatus.GONE,
      );
    }
    if (link.expiresAt.getTime() <= this.now()) {
      throw new AppException(GUEST_ERRORS.linkExpired, "This link has expired.", HttpStatus.GONE);
    }
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

  /** A page load: counted as a visit when the last one was a while ago. Best effort. */
  private async recordVisit(link: ClipGuestLink): Promise<void> {
    const now = this.now();
    const newVisit =
      link.lastViewedAt === null || now - link.lastViewedAt.getTime() >= VISIT_GAP_MS;
    try {
      await this.prisma.clipGuestLink.update({
        where: { id: link.id },
        data: {
          lastViewedAt: new Date(now),
          ...(newVisit ? { viewCount: { increment: 1 } } : {}),
        },
      });
    } catch (error) {
      this.logger.warn({ linkId: link.id, err: error }, "could not count a guest link visit");
    }
  }

  // -------------------------------------------------------------------------
  // The clips
  // -------------------------------------------------------------------------

  /**
   * The clips the link shares, as the run's page lists them (a removed
   * moment's clip is not one), in the order their moments come in the video.
   * Scoped by the link's run AND workspace, whatever ids the link names.
   */
  private async sharedClips(link: ClipGuestLink): Promise<SharedClip[]> {
    return runClipsOf(
      this.prisma,
      { workspaceId: link.workspaceId, runId: link.runId },
      link.allClips ? undefined : link.clipIds,
    );
  }

  /** Each shared clip's plan, in order; null for a clip with nothing to offer yet. */
  private async plansOf(
    link: ClipGuestLink,
    clips: readonly SharedClip[],
  ): Promise<(GuestClipPlan | null)[]> {
    if (clips.length === 0) return [];
    const ids = clips.map((clip) => clip.id);
    const [captioned, clean, approvals, dubs] = await Promise.all([
      reviewVideosOf(this.prisma, ids),
      cleanCutsOf(this.prisma, ids),
      this.gate.forClips(link.workspaceId, ids),
      link.includeDubs
        ? dubFilesOf(this.prisma, { workspaceId: link.workspaceId, runId: link.runId }, ids)
        : new Map<string, DubFiles[]>(),
    ]);
    return clips.map((clip) => {
      const approval = approvals.get(clip.id);
      if (approval === undefined) return null;
      return planGuestClip({
        id: clip.id,
        title: clip.title,
        copy: clip.copy,
        images: clip.images,
        durationMs: clip.mezzanineDurationMs,
        captioned: captioned.get(clip.id) ?? new Map(),
        clean: clean.get(clip.id) ?? new Map(),
        approval,
        dubs: dubs.get(clip.id) ?? [],
      });
    });
  }

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  /** A clip's plan, signed. Null when not one of its files could be signed. */
  private async signed(link: ClipGuestLink, plan: GuestClipPlan): Promise<GuestClipView | null> {
    const sign = async (key: string, filename?: string): Promise<string | null> => {
      // Before every signature: a key outside the link's own workspace is never signed.
      if (!keyBelongsToWorkspace(key, link.workspaceId)) {
        this.logger.warn({ linkId: link.id, clipId: plan.id }, "refused to sign a foreign key");
        return null;
      }
      try {
        return await this.derived.presignGet(
          key,
          GUEST_URL_TTL_SECONDS,
          filename === undefined ? undefined : { downloadFilename: filename },
        );
      } catch (error) {
        this.logger.warn({ linkId: link.id, clipId: plan.id, err: error }, "could not sign a file");
        return null;
      }
    };
    const signShapes = async (
      shapes: readonly ShapeFiles[],
      ...suffix: readonly string[]
    ): Promise<GuestVideoView[]> => {
      const views = await Promise.all(
        shapes.map(async (files): Promise<GuestVideoView | null> => {
          const tag = files.shape.replace(":", "x");
          const [url, cleanUrl] = await Promise.all([
            files.captionedKey === null
              ? null
              : sign(files.captionedKey, `${fileStem(plan.title, tag, ...suffix)}.mp4`),
            files.cleanKey === null
              ? null
              : sign(files.cleanKey, `${fileStem(plan.title, tag, ...suffix, "no captions")}.mp4`),
          ]);
          if (url === null && cleanUrl === null) return null;
          return { shape: files.shape, ...shapeSize(files.shape), url, cleanUrl };
        }),
      );
      return views.filter((view): view is GuestVideoView => view !== null);
    };

    const [videos, images, dubs, playerUrl, posterUrl] = await Promise.all([
      signShapes(plan.videos),
      Promise.all(
        plan.images.map(async (image) => {
          const urls = await Promise.all(
            image.keys.map((entry) => sign(entry.key, `${fileStem(plan.title, entry.name)}.jpg`)),
          );
          const signedUrls = urls.filter((url): url is string => url !== null);
          return signedUrls.length === 0
            ? null
            : { id: image.id, width: image.width, height: image.height, urls: signedUrls };
        }),
      ),
      Promise.all(
        plan.dubs.map(async (dub) => {
          const shapes = await signShapes(dub.videos, dub.name);
          return shapes.length === 0
            ? null
            : { language: dub.language, name: dub.name, videos: shapes };
        }),
      ),
      plan.player === null ? null : sign(plan.player.key),
      plan.player?.posterKey === null || plan.player === null ? null : sign(plan.player.posterKey),
    ]);
    if (videos.length === 0) return null;
    return {
      id: plan.id,
      title: plan.title,
      durationMs: plan.durationMs,
      player:
        plan.player === null || playerUrl === null
          ? null
          : {
              shape: plan.player.shape,
              url: playerUrl,
              captioned: plan.player.captioned,
              posterUrl,
            },
      videos,
      images: images.filter((image) => image !== null),
      dubs: dubs.filter((dub) => dub !== null),
      hashtags: plan.hashtags,
      posts: plan.posts,
    };
  }

  // -------------------------------------------------------------------------
  // The episode
  // -------------------------------------------------------------------------

  /** The posts the run's episode text wrote for the whole video, when it did. */
  private async episodeOf(
    link: ClipGuestLink,
    sourceProjectId: string,
  ): Promise<GuestPageView["episode"]> {
    const pack = await episodePackOf(this.prisma, link.workspaceId, sourceProjectId);
    if (pack === null) return null;
    const linkedin = pack.linkedinPost.trim();
    const xThread = pack.xThread.map((post) => post.trim()).filter((post) => post !== "");
    if (linkedin === "" && xThread.length === 0) return null;
    return { linkedin: linkedin === "" ? null : linkedin, xThread };
  }
}

type SharedClip = RunClipRow;

function linkNotFound(): AppException {
  return new AppException(
    GUEST_ERRORS.linkNotFound,
    "This link does not exist.",
    HttpStatus.NOT_FOUND,
  );
}
