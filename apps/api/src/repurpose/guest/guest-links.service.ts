import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { type Env, surfaceEnabled } from "@montaj/config";

import { GUEST_ERRORS, MAX_GUEST_LINKS_PER_RUN } from "./guest.constants.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, PrismaService } from "../../common/index.js";
import { ENV } from "../../config/config.module.js";
import { REPURPOSE_ERRORS } from "../repurpose.constants.js";
import { ClipReviewService, linkStatus, type MemberCaller } from "../review/clip-review.service.js";
import { generateReviewToken, hashReviewToken, tokenHint } from "../review/review-token.js";

import type { CreateGuestLinkInput, CreatedGuestLinkView, GuestLinkView } from "./guest.dto.js";
import type { ClipGuestLink } from "@prisma/client";

/**
 * Guest links, the team's side (2026-10-05): a link a podcaster sends their
 * guest, where the guest downloads the clips they appear in, ready to repost,
 * with no account (`guest-page.service.ts` is the page it opens).
 *
 * The machinery is the client review links' (`repurpose/review`), reused:
 *
 *   * **The token** is minted and hashed by `review-token.ts` (24 base62
 *     characters, over 142 bits, from `randomInt`), and only its SHA-256 and
 *     last four characters are stored. The full link is in the answer to the
 *     request that made it, once, and never again.
 *   * **The checks** are `ClipReviewService`'s: `repurpose_flow` on for the
 *     workspace, the run looked up by workspace and id together, and the
 *     run's clips as its page lists them (a removed moment's clip is not one).
 *   * **Expiry** is 1-30 days (14 unless asked), and a link can be revoked.
 *
 * What differs is who may make one. A review link hands its holder approval,
 * so only an owner or admin makes it; a guest link hands a guest the files the
 * team chose, which any editor can already download and send, so editors and
 * up make and revoke them (the controller's `@Roles("editor")`).
 *
 * **Audited**: every link made and every link revoked writes `audit_log`.
 */
@Injectable()
export class GuestLinksService {
  /** A field so a test can set the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
    private readonly reviews: ClipReviewService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Make a link to every clip of the run (clips made later included) or to the
   * ones named. A named clip that is not one of the run's listed clips refuses
   * the whole request (400 `guest/clip_not_in_run`): a link never names a clip
   * of another run, and never one the team removed.
   */
  async createLink(
    workspaceId: string,
    caller: MemberCaller,
    runId: string,
    input: CreateGuestLinkInput,
  ): Promise<CreatedGuestLinkView> {
    await this.reviews.assertAvailable(workspaceId);
    this.assertPublicLinks();
    const run = await this.reviews.requireRun(workspaceId, runId);
    const listed = await this.reviews.listedClipIds(run.id);
    let clipIds: string[] = [];
    if (!input.allClips) {
      clipIds = [...new Set(input.clipIds)];
      const known = new Set(listed);
      if (clipIds.length === 0 || clipIds.some((id) => !known.has(id))) {
        throw new AppException(
          GUEST_ERRORS.clipNotInRun,
          "One of those clips is no longer part of this video. Choose the clips again.",
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const now = this.now();
    const live = await this.prisma.clipGuestLink.count({
      where: { workspaceId, runId: run.id, revokedAt: null, expiresAt: { gt: new Date(now) } },
    });
    if (live >= MAX_GUEST_LINKS_PER_RUN) {
      throw new AppException(
        GUEST_ERRORS.tooManyLinks,
        `This video already has ${String(MAX_GUEST_LINKS_PER_RUN)} guest links. Turn off one you no longer need first.`,
        HttpStatus.CONFLICT,
      );
    }

    const token = generateReviewToken();
    const guestName =
      input.guestName === undefined || input.guestName.trim() === ""
        ? null
        : input.guestName.trim();
    const link = await this.prisma.clipGuestLink.create({
      data: {
        id: ulid(),
        workspaceId,
        runId: run.id,
        tokenHash: hashReviewToken(token),
        tokenHint: tokenHint(token),
        guestName,
        allClips: input.allClips,
        clipIds,
        includeDubs: input.includeDubs,
        expiresAt: new Date(now + input.expiresInDays * 24 * 60 * 60_000),
        createdBy: caller.userId,
        createdAt: new Date(now),
      },
    });
    await this.audit.record({
      action: "repurpose.guest_link.created",
      resource: "clip_guest_link",
      resourceId: link.id,
      actorId: caller.userId,
      workspaceId,
      data: {
        runId: run.id,
        expiresAt: link.expiresAt.toISOString(),
        allClips: link.allClips,
        clipIds: link.clipIds,
        includeDubs: link.includeDubs,
        named: link.guestName !== null,
        hint: link.tokenHint,
      },
    });
    return {
      ...this.linkView(link, listed),
      url: new URL(`/share/guest/${token}`, this.env.WEB_ORIGIN).toString(),
    };
  }

  /** The run's guest links, newest first. Never the link itself. */
  async listLinks(workspaceId: string, runId: string): Promise<GuestLinkView[]> {
    await this.reviews.assertAvailable(workspaceId);
    const run = await this.reviews.requireRun(workspaceId, runId);
    const links = await this.prisma.clipGuestLink.findMany({
      where: { workspaceId, runId: run.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    if (links.length === 0) return [];
    const listed = await this.reviews.listedClipIds(run.id);
    return links.map((link) => this.linkView(link, listed));
  }

  /** Revoke a link: it stops opening at once. Editors and up; it only takes access away. */
  async revokeLink(
    workspaceId: string,
    caller: MemberCaller,
    runId: string,
    linkId: string,
  ): Promise<GuestLinkView> {
    await this.reviews.assertAvailable(workspaceId);
    const run = await this.reviews.requireRun(workspaceId, runId);
    const link = await this.prisma.clipGuestLink.findFirst({
      where: { id: linkId, runId: run.id, workspaceId },
    });
    if (link === null) {
      throw new AppException(
        GUEST_ERRORS.linkNotFound,
        "We could not find that guest link.",
        HttpStatus.NOT_FOUND,
      );
    }
    let row = link;
    if (link.revokedAt === null) {
      const at = new Date(this.now());
      await this.prisma.clipGuestLink.updateMany({
        where: { id: link.id, revokedAt: null },
        data: { revokedAt: at, revokedBy: caller.userId },
      });
      row = { ...link, revokedAt: at, revokedBy: caller.userId };
      await this.audit.record({
        action: "repurpose.guest_link.revoked",
        resource: "clip_guest_link",
        resourceId: link.id,
        actorId: caller.userId,
        workspaceId,
        data: { runId: run.id, hint: link.tokenHint },
      });
    }
    return this.linkView(row, await this.reviews.listedClipIds(run.id));
  }

  /** Guest links live on the public share surface (`shares.public`): 404 while it is off. */
  assertPublicLinks(): void {
    if (surfaceEnabled("publicShares", this.env.FEATURE_FLAGS_JSON)) return;
    throw new AppException(
      REPURPOSE_ERRORS.disabled,
      "Sharing clips with a guest is not available yet.",
      HttpStatus.NOT_FOUND,
    );
  }

  private linkView(link: ClipGuestLink, listed: readonly string[]): GuestLinkView {
    const onRun = new Set(listed);
    const named = link.allClips ? [] : link.clipIds.filter((id) => onRun.has(id));
    return {
      id: link.id,
      runId: link.runId,
      hint: link.tokenHint,
      guestName: link.guestName,
      allClips: link.allClips,
      clipIds: named,
      clipCount: link.allClips ? listed.length : named.length,
      includeDubs: link.includeDubs,
      expiresAt: link.expiresAt.toISOString(),
      revokedAt: iso(link.revokedAt),
      status: linkStatus(link, this.now()),
      createdBy: link.createdBy,
      createdAt: link.createdAt.toISOString(),
      visits: link.viewCount,
      lastVisitAt: iso(link.lastViewedAt),
      downloads: link.downloadCount,
      lastDownloadAt: iso(link.lastDownloadedAt),
    };
  }
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}
