import { Inject, Injectable, Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";

import {
  DEVICE_CODE_TTL_SEC,
  EMAIL_VERIFICATION_TTL_SEC,
  MAGIC_LINK_TTL_SEC,
} from "./auth.constants.js";
import { maskEmail } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { NotifyService } from "../notify/notify.service.js";

import type { NotifyKind } from "../notify/notify.kinds.js";

/** The transactional messages A04 needs to send. */
export type AuthMailTemplate = "email_verification" | "magic_link" | "device_approved";

export interface AuthMail {
  readonly to: string;
  readonly template: AuthMailTemplate;
  /** The https link the recipient clicks. Carries the single-use token. */
  readonly link: string;
  /** Raw token, so a developer can complete the flow without a mail server. */
  readonly token?: string;
  /** BCP-47. Falls back to English when the user has no locale yet. */
  readonly locale?: string;
  /** Shown in the greeting when known. */
  readonly name?: string;
}

/**
 * A04's template names, and how long each one's link lives.
 *
 * The names are A04's public vocabulary — they appear in its e2e suite and in the
 * development outbox — so they are mapped here rather than renamed: A25 owns the
 * kinds, A04 owns the flows, and one lookup table is cheaper than changing both.
 */
const TEMPLATE_KINDS: Readonly<Record<AuthMailTemplate, NotifyKind>> = Object.freeze({
  email_verification: "verify-email",
  magic_link: "magic-link",
  device_approved: "device-approval",
});

/**
 * Per-template variables the notify layer cannot know.
 *
 * They are the constants of `auth.constants.ts` in the unit the copy uses: the
 * verification link's 24 hours, the magic link's 15 minutes, the device grant's
 * 10. Duplicating the numbers here would be the mistake `auth.constants.ts`
 * exists to prevent, so they are derived from it.
 */
function variablesFor(mail: AuthMail): Record<string, string | number> {
  switch (mail.template) {
    case "email_verification":
      return { link: mail.link, hours: Math.round(EMAIL_VERIFICATION_TTL_SEC / 3600) };
    case "magic_link":
      return { link: mail.link, minutes: Math.round(MAGIC_LINK_TTL_SEC / 60) };
    case "device_approved":
      return { link: mail.link, minutes: Math.round(DEVICE_CODE_TTL_SEC / 60) };
  }
}

/**
 * Delivery of the auth emails.
 *
 * A04 shipped this class as a logger and a Redis outbox, because there was no
 * mail provider in CONTRACTS section 1 and no `notify` consumer to hand a message
 * to. A25 added both, so the class is now what its name always claimed: a thin
 * adapter from A04's vocabulary (`template`, `link`, `token`) to the notify
 * queue's (`kind`, `data`, `idempotencyKey`).
 *
 * The `link` and the `token` are forwarded as **development-outbox extras**, not
 * as tags: they are single-use credentials, so they must never reach a provider's
 * reporting surface. `MAIL_PROVIDER=dev` writes them to the same Redis list at
 * the same key A04 used, which is what keeps `test/auth.e2e-spec.ts` able to
 * complete a sign-up without a mail server.
 *
 * Enqueueing does not throw for a delivery reason (see {@link NotifyService}), so
 * a sign-up still succeeds when Redis is unavailable — and says so in the log
 * rather than failing the request the user made.
 */
@Injectable()
export class AuthMailerService {
  private readonly logger = new Logger(AuthMailerService.name);

  constructor(
    private readonly notify: NotifyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async send(mail: AuthMail): Promise<void> {
    const kind = TEMPLATE_KINDS[mail.template];

    await this.notify.enqueue({
      kind,
      to: mail.to,
      ...(mail.locale === undefined ? {} : { locale: mail.locale }),
      data: {
        ...variablesFor(mail),
        ...(mail.name === undefined || mail.name === "" ? {} : { name: mail.name }),
      },
      // The token IS the unit of work: one link, one message. Two requests for
      // the same link cannot happen (each mints a fresh token), and a retry of
      // the same request must not send twice.
      ...(mail.token === undefined ? {} : { idempotencyKey: `${kind}-${mail.token.slice(0, 32)}` }),
      devOutbox: {
        template: mail.template,
        ...(mail.token === undefined ? {} : { token: mail.token }),
        link: mail.link,
      },
    });

    this.logger.log({ template: mail.template, to: maskEmail(mail.to) }, "auth email queued");
  }

  /** `${WEB_ORIGIN}/<path>?<query>` — every link a user clicks is a web link. */
  webLink(path: string, query: Record<string, string>): string {
    const url = new URL(path, this.env.WEB_ORIGIN);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url.toString();
  }
}
