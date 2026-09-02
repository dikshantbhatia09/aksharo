import { Inject, Injectable, Logger } from "@nestjs/common";

import { BRAND } from "@montaj/config";
import type { Env } from "@montaj/config";

import { redisKeys } from "../auth/auth.constants.js";
import { maskEmail, RedisService } from "../common/index.js";
import { ENV } from "../config/config.module.js";

/** The messages the workspaces module needs sent. */
export interface MemberInvitedMail {
  readonly to: string;
  readonly invitationId: string;
  readonly workspaceName: string;
  readonly invitedByName: string | null;
  readonly role: string;
}

/**
 * B08: the second channel for `POST /workspaces/{id}/transfer-ownership`'s
 * confirmation step (`teams/ownership-transfer.service.ts`) — sent to the
 * *current* owner, not the incoming one, so a hijacked session gets noticed
 * before the workspace moves.
 */
export interface OwnershipTransferRequestedMail {
  readonly to: string;
  readonly workspaceName: string;
  readonly confirmationToken: string;
}

/**
 * The port everything that has to reach a person by email goes through.
 *
 * An interface rather than a class so the module never depends on a transport:
 * A25 owns delivery (CONTRACTS §1 named `MAIL_PROVIDER`, `MAIL_FROM` and
 * `SMTP_URL` for it) and will bind this token to a producer for the `notify`
 * queue of CONTRACTS §3. Nothing in this module changes when that happens.
 */
export interface WorkspaceNotifier {
  memberInvited(mail: MemberInvitedMail): Promise<void>;
  ownershipTransferRequested(mail: OwnershipTransferRequestedMail): Promise<void>;
}

export const WORKSPACE_NOTIFIER = Symbol("WORKSPACE_NOTIFIER");

/** How many messages the development outbox keeps. */
const DEV_OUTBOX_LIMIT = 50;
const DEV_OUTBOX_TTL_SEC = 60 * 60;

/**
 * The stand-in until A25: log that a message was due (address masked, because
 * `redactLogObject` treats an address as personal data) and, outside production,
 * push it onto the same Redis list A04's mailer uses, so a developer completes an
 * invitation without a mail server and one outbox holds every message.
 *
 * In production it logs a warning and delivers nothing, which is the honest
 * behaviour: silently dropping an invitation would look like a bug in the invite
 * flow rather than a missing transport.
 */
@Injectable()
export class LoggingWorkspaceNotifier implements WorkspaceNotifier {
  private readonly logger = new Logger(LoggingWorkspaceNotifier.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async memberInvited(mail: MemberInvitedMail): Promise<void> {
    const link = this.webLink("/invitations", { id: mail.invitationId });
    this.logger.log(
      { template: "member_invited", to: maskEmail(mail.to), brand: BRAND.name },
      "workspace invitation queued",
    );

    if (process.env["NODE_ENV"] === "production") {
      this.logger.warn(
        { template: "member_invited" },
        "no mail transport is configured; the invitation was not delivered",
      );
      return;
    }

    try {
      const key = redisKeys.devOutbox();
      await this.redis.client
        .multi()
        .lpush(
          key,
          JSON.stringify({
            to: mail.to,
            template: "member_invited",
            token: mail.invitationId,
            link,
            workspaceName: mail.workspaceName,
            role: mail.role,
            at: new Date().toISOString(),
          }),
        )
        .ltrim(key, 0, DEV_OUTBOX_LIMIT - 1)
        .expire(key, DEV_OUTBOX_TTL_SEC)
        .exec();
    } catch (error) {
      this.logger.warn({ err: error }, "development mail outbox unavailable");
    }
  }

  async ownershipTransferRequested(mail: OwnershipTransferRequestedMail): Promise<void> {
    this.logger.log(
      { template: "ownership_transfer_requested", to: maskEmail(mail.to), brand: BRAND.name },
      "ownership transfer confirmation queued",
    );

    if (process.env["NODE_ENV"] === "production") {
      this.logger.warn(
        { template: "ownership_transfer_requested" },
        "no mail transport is configured; the confirmation was not delivered",
      );
      return;
    }

    try {
      const key = redisKeys.devOutbox();
      await this.redis.client
        .multi()
        .lpush(
          key,
          JSON.stringify({
            to: mail.to,
            template: "ownership_transfer_requested",
            token: mail.confirmationToken,
            workspaceName: mail.workspaceName,
            at: new Date().toISOString(),
          }),
        )
        .ltrim(key, 0, DEV_OUTBOX_LIMIT - 1)
        .expire(key, DEV_OUTBOX_TTL_SEC)
        .exec();
    } catch (error) {
      this.logger.warn({ err: error }, "development mail outbox unavailable");
    }
  }

  private webLink(path: string, query: Record<string, string>): string {
    const url = new URL(path, this.env.WEB_ORIGIN);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url.toString();
  }
}
