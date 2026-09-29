import { Inject, Injectable, Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { COMMENT_NOTICE_GAP_MS } from "./review.constants.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ENV } from "../../config/config.module.js";
import { NotifyService } from "../../notify/notify.service.js";
import { cleanSourceTitle } from "../repurpose.projection.js";

/**
 * Tells a run's creator what happened in its review (2026-10-03): a clip
 * approved or sent back for changes, a comment, or a clip back in review
 * because its video changed after a decision. One kind, `clip-review`, in the
 * bell, by email (logged only while mail is `dev`) and on their devices.
 *
 *   * **To the person who started the run**, while they are an active member of
 *     its workspace; else the workspace's owner - the rule `run-notifications.ts`
 *     holds to: news about a workspace's video is the workspace's.
 *   * **Never about their own action.** Approving your own clip is not news.
 *   * **Comments are grouped**: one clip's comments tell them at most once per
 *     {@link COMMENT_NOTICE_GAP_MS}, so a client going through a run is not a
 *     notification per note.
 *   * **Never throws.** A notification is a side effect of the decision the
 *     caller has already recorded.
 */

export type ReviewVerdict = "approved" | "changes" | "comment" | "reopened";

export interface ReviewNotice {
  readonly workspaceId: string;
  readonly runId: string;
  readonly clipId: string;
  readonly verdict: ReviewVerdict;
  /** Who did it. `userId` for a member; a client's name (or none); nobody for Aksharo. */
  readonly actor:
    | { readonly kind: "member"; readonly userId: string }
    | { readonly kind: "client"; readonly name: string | null }
    | { readonly kind: "system" };
  /** The event or comment behind it: one message per id, however many passes see it. */
  readonly sourceId: string;
}

interface Recipient {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly locale: string;
}

@Injectable()
export class ReviewNotifier {
  private readonly logger = new Logger(ReviewNotifier.name);

  /** A field so a test can set the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async send(notice: ReviewNotice): Promise<void> {
    try {
      await this.deliver(notice);
    } catch (error) {
      this.logger.warn(
        { runId: notice.runId, clipId: notice.clipId, verdict: notice.verdict, err: error },
        "clip review notification not sent",
      );
    }
  }

  private async deliver(notice: ReviewNotice): Promise<void> {
    const run = await this.prisma.repurposeRun.findFirst({
      where: { id: notice.runId, workspaceId: notice.workspaceId },
      select: {
        id: true,
        workspaceId: true,
        createdBy: true,
        sourceTitle: true,
        sourceProject: { select: { title: true } },
      },
    });
    if (run === null) return;
    const recipient = await this.recipientFor(run);
    if (recipient === null) return;
    if (notice.actor.kind === "member" && notice.actor.userId === recipient.id) return;

    if (notice.verdict === "comment" && (await this.toldAboutCommentsLately(recipient, notice))) {
      return;
    }

    const clip = await this.prisma.repurposeClip.findFirst({
      where: { id: notice.clipId, runId: run.id },
      select: { title: true },
    });
    const video = cleanSourceTitle(run.sourceTitle) ?? cleanSourceTitle(run.sourceProject.title);
    const title = cleanSourceTitle(clip?.title);
    const { by, who } = await this.actorWords(notice.actor);
    const link = new URL(`/repurpose/${run.id}`, this.env.WEB_ORIGIN);
    link.hash = `clip-${notice.clipId}`;

    await this.notify.enqueue({
      kind: "clip-review",
      to: recipient.email,
      locale: recipient.locale,
      userId: recipient.id,
      workspaceId: run.workspaceId,
      data: {
        verdict: notice.verdict,
        by,
        who,
        // Absent, each language's own "a clip" / "your video" is used.
        ...(title === null ? {} : { clip: title.slice(0, 80) }),
        ...(video === null ? {} : { video: video.slice(0, 80) }),
        ...(recipient.name === null || recipient.name.trim() === ""
          ? {}
          : { name: recipient.name }),
        runId: run.id,
        clipId: notice.clipId,
        link: link.toString(),
      },
      idempotencyKey: `clip-review:${notice.verdict}:${notice.sourceId}`,
      thread: `${run.id}:${notice.clipId}`,
    });
  }

  /**
   * `by`: `member`, `client` (with a name), `guest` (a client who gave none) or
   * `system`; `who`: the name the sentence uses. A member is their name, or the
   * part of their address before the `@`.
   */
  private async actorWords(
    actor: ReviewNotice["actor"],
  ): Promise<{ readonly by: string; readonly who: string }> {
    if (actor.kind === "system") return { by: "system", who: "" };
    if (actor.kind === "client") {
      const name = actor.name?.trim() ?? "";
      return name === "" ? { by: "guest", who: "" } : { by: "client", who: name.slice(0, 60) };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { name: true, email: true },
    });
    const name = user?.name?.trim();
    return {
      by: "member",
      who: name !== undefined && name !== "" ? name : (user?.email.split("@")[0] ?? "Someone"),
    };
  }

  /** A comment notification about this clip reached them within the gap. */
  private async toldAboutCommentsLately(
    recipient: Recipient,
    notice: ReviewNotice,
  ): Promise<boolean> {
    const recent = await this.prisma.notification.findFirst({
      where: {
        userId: recipient.id,
        kind: "clip-review",
        createdAt: { gte: new Date(this.now() - COMMENT_NOTICE_GAP_MS) },
        AND: [
          { data: { path: ["clipId"], equals: notice.clipId } },
          { data: { path: ["verdict"], equals: "comment" } },
        ],
      },
      select: { id: true },
    });
    return recent !== null;
  }

  /** The run's creator while an active member; else the workspace's owner. */
  private async recipientFor(run: {
    readonly workspaceId: string;
    readonly createdBy: string | null;
  }): Promise<Recipient | null> {
    const select = { id: true, email: true, name: true, locale: true } as const;
    if (run.createdBy !== null) {
      const creator = await this.prisma.user.findFirst({
        where: {
          id: run.createdBy,
          deletedAt: null,
          memberships: { some: { workspaceId: run.workspaceId, status: "active" } },
        },
        select,
      });
      if (creator !== null) return creator;
    }
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: run.workspaceId, deletedAt: null },
      select: { owner: { select: { ...select, deletedAt: true } } },
    });
    const owner = workspace?.owner;
    if (owner === undefined || owner.deletedAt !== null) return null;
    return { id: owner.id, email: owner.email, name: owner.name, locale: owner.locale };
  }
}
