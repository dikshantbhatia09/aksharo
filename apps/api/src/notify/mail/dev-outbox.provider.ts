import { Logger } from "@nestjs/common";

import type { MailProviderName } from "@montaj/config";

import { redisKeys } from "../../auth/auth.constants.js";

import type { MailMessage, MailProvider, MailSendResult } from "./mail.provider.js";
import type Redis from "ioredis";

/** How many messages the outbox keeps, and for how long. A04's numbers, unchanged. */
export const DEV_OUTBOX_LIMIT = 50;
export const DEV_OUTBOX_TTL_SEC = 60 * 60;

/** One entry as it is stored, newest first, in `montaj:auth:dev-outbox`. */
export interface DevOutboxEntry {
  readonly to: string;
  /** A04's template name; the A04 e2e suite finds messages by it. */
  readonly template: string;
  readonly token?: string;
  readonly link?: string;
  readonly kind: string;
  readonly locale: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly at: string;
}

/**
 * `MAIL_PROVIDER=dev`: a Redis list instead of a mail server.
 *
 * This is A04's outbox, at A04's key, in A04's shape plus the rendered message —
 * a developer who has not configured anything still gets a working sign-up flow,
 * and `test/auth.e2e-spec.ts` still completes real flows by reading the token out
 * of it. `tools/runbooks/mail-outbox.js` prints it.
 *
 * Never exposed over HTTP, and it refuses to run in production: a deployment that
 * reaches this class has misconfigured `MAIL_PROVIDER` and would drop real mail on
 * the floor, so it says so instead of pretending to have sent something.
 */
export class DevOutboxProvider implements MailProvider {
  readonly name: MailProviderName = "dev";
  private readonly logger = new Logger(DevOutboxProvider.name);

  constructor(private readonly redis: Redis) {}

  async send(message: MailMessage): Promise<MailSendResult> {
    const entry: DevOutboxEntry = {
      to: message.to,
      template: message.devOutbox?.template ?? message.tags?.["kind"] ?? "unknown",
      ...(message.devOutbox?.token === undefined ? {} : { token: message.devOutbox.token }),
      ...(message.devOutbox?.link === undefined ? {} : { link: message.devOutbox.link }),
      kind: message.tags?.["kind"] ?? "unknown",
      locale: message.tags?.["locale"] ?? "en",
      subject: message.subject,
      text: message.text,
      html: message.html,
      at: new Date().toISOString(),
    };

    const key = redisKeys.devOutbox();
    await this.redis
      .multi()
      .lpush(key, JSON.stringify(entry))
      .ltrim(key, 0, DEV_OUTBOX_LIMIT - 1)
      .expire(key, DEV_OUTBOX_TTL_SEC)
      .exec();

    this.logger.debug({ kind: entry.kind }, "message written to the development outbox");
    return { providerMessageId: message.idempotencyKey };
  }
}
