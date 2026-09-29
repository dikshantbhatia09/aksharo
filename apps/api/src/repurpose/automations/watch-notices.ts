import { Inject, Injectable, Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ENV } from "../../config/config.module.js";
import { NotifyService } from "../../notify/notify.service.js";

import type { WatchStateReason } from "./source-watch.constants.js";

/**
 * What a channel automation tells its person (2026-10-02), in the bell and by
 * email (logged only while production mail is `dev`), from the same catalogue
 * as every other notification (`notify/templates`, en and hi):
 *
 *   * `watch-new-video` - "New episode found - making clips": once per run a
 *     watch starts (its idempotency key is the run's id). Not a device kind:
 *     the run's own "your clips are ready" is the buzz worth having.
 *   * `watch-paused` - the watch stopped for something the person can fix:
 *     out of credits, a caption look that is gone, settings that no longer
 *     pass, a channel that has disappeared. Once per pause (keyed by when it
 *     paused), and a device kind: nothing new happens until they act.
 *
 * Sent to whoever the watch starts runs as while they are still an active
 * member, else the workspace's owner. Never throws: a notification is a side
 * effect of work already done.
 */

interface Recipient {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly locale: string;
}

interface WatchRef {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly title: string;
}

/** The reasons worth a message; a person's own pause, and the creator leaving, are not. */
const PAUSE_NOTICES: Partial<Record<WatchStateReason, "credits" | "style" | "setup" | "channel">> =
  {
    no_credits: "credits",
    style_unknown: "style",
    setup_invalid: "setup",
    channel_not_found: "channel",
  };

@Injectable()
export class WatchNotifier {
  private readonly logger = new Logger(WatchNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** "New episode found - making clips". */
  async newVideo(
    watch: WatchRef,
    video: { readonly title: string; readonly runId: string },
  ): Promise<void> {
    await this.send(watch, {
      kind: "watch-new-video",
      idempotencyKey: `watch-new-video:${video.runId}`,
      thread: video.runId,
      data: {
        channel: watch.title.slice(0, 80),
        ...(video.title.trim() === "" ? {} : { video: video.title.slice(0, 80) }),
        runId: video.runId,
        link: new URL(`/repurpose/${video.runId}`, this.env.WEB_ORIGIN).toString(),
      },
    });
  }

  /** The watch paused itself for `reason`, at `at`. */
  async paused(watch: WatchRef, reason: WatchStateReason, at: Date): Promise<void> {
    // eslint-disable-next-line security/detect-object-injection -- a WatchStateReason, one of the table's keys
    const notice = PAUSE_NOTICES[reason];
    if (notice === undefined) return;
    await this.send(watch, {
      kind: "watch-paused",
      idempotencyKey: `watch-paused:${watch.id}:${String(at.getTime())}`,
      thread: `watch:${watch.id}`,
      data: {
        channel: watch.title.slice(0, 80),
        reason: notice,
        link: new URL("/repurpose/automations", this.env.WEB_ORIGIN).toString(),
      },
    });
  }

  private async send(
    watch: WatchRef,
    message: {
      readonly kind: "watch-new-video" | "watch-paused";
      readonly idempotencyKey: string;
      readonly thread: string;
      readonly data: Record<string, string>;
    },
  ): Promise<void> {
    try {
      const recipient = await this.recipientFor(watch);
      if (recipient === null) {
        this.logger.warn(
          { watchId: watch.id, kind: message.kind },
          "a watch notice has nobody to go to",
        );
        return;
      }
      await this.notify.enqueue({
        kind: message.kind,
        to: recipient.email,
        locale: recipient.locale,
        userId: recipient.id,
        workspaceId: watch.workspaceId,
        data: {
          ...message.data,
          ...(recipient.name === null || recipient.name.trim() === ""
            ? {}
            : { name: recipient.name }),
        },
        idempotencyKey: message.idempotencyKey,
        thread: message.thread,
      });
    } catch (error) {
      this.logger.warn(
        { watchId: watch.id, kind: message.kind, err: error },
        "watch notice not sent",
      );
    }
  }

  private async recipientFor(watch: WatchRef): Promise<Recipient | null> {
    const select = { id: true, email: true, name: true, locale: true } as const;
    const creator = await this.prisma.user.findFirst({
      where: {
        id: watch.createdBy,
        deletedAt: null,
        memberships: { some: { workspaceId: watch.workspaceId, status: "active" } },
      },
      select,
    });
    if (creator !== null) return creator;
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: watch.workspaceId, deletedAt: null },
      select: { owner: { select: { ...select, deletedAt: true } } },
    });
    const owner = workspace?.owner;
    if (owner === undefined || owner.deletedAt !== null) return null;
    return { id: owner.id, email: owner.email, name: owner.name, locale: owner.locale };
  }
}
