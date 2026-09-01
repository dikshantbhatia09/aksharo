import { Inject, Injectable, Logger } from "@nestjs/common";

import { BRAND } from "@montaj/config";
import type { Env } from "@montaj/config";

import { redisKeys } from "./auth.constants.js";
import { maskEmail, RedisService } from "../common/index.js";
import { ENV } from "../config/config.module.js";

/** The transactional messages A04 needs to send. */
export type AuthMailTemplate = "email_verification" | "magic_link" | "device_approved";

export interface AuthMail {
  readonly to: string;
  readonly template: AuthMailTemplate;
  /** The https link the recipient clicks. Carries the single-use token. */
  readonly link: string;
  /** Raw token, so a developer can complete the flow without a mail server. */
  readonly token?: string;
}

/** How many messages the development outbox keeps. */
const DEV_OUTBOX_LIMIT = 50;
const DEV_OUTBOX_TTL_SEC = 60 * 60;

/**
 * Delivery of the auth emails.
 *
 * There is no mail provider in CONTRACTS §1 and no `notify` consumer until A08,
 * so A04 does the only honest thing: it logs that a message was due (with the
 * address masked — `redactLogObject` treats addresses as personal data) and, in
 * every environment except production, pushes the message onto a Redis list so a
 * developer and the e2e suite can complete the flow.
 *
 * The outbox is never exposed over HTTP. Tests read the Redis list directly.
 */
@Injectable()
export class AuthMailerService {
  private readonly logger = new Logger(AuthMailerService.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get isProduction(): boolean {
    return process.env["NODE_ENV"] === "production";
  }

  async send(mail: AuthMail): Promise<void> {
    this.logger.log(
      { template: mail.template, to: maskEmail(mail.to), brand: BRAND.name },
      "auth email queued",
    );

    if (this.isProduction) {
      // A08 replaces this with a `notify` queue job. Until then, refusing to
      // silently drop the message in production is the point of the warning.
      this.logger.warn(
        { template: mail.template },
        "no mail transport is configured; the message was not delivered",
      );
      return;
    }

    try {
      const key = redisKeys.devOutbox();
      await this.redis.client
        .multi()
        .lpush(key, JSON.stringify({ ...mail, at: new Date().toISOString() }))
        .ltrim(key, 0, DEV_OUTBOX_LIMIT - 1)
        .expire(key, DEV_OUTBOX_TTL_SEC)
        .exec();
    } catch (error) {
      this.logger.warn({ err: error }, "development mail outbox unavailable");
    }
  }

  /** `${WEB_ORIGIN}/<path>?<query>` — every link a user clicks is a web link. */
  webLink(path: string, query: Record<string, string>): string {
    const url = new URL(path, this.env.WEB_ORIGIN);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url.toString();
  }
}
