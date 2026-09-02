import { Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { DevOutboxProvider } from "./dev-outbox.provider.js";
import { SesProvider } from "./ses.provider.js";
import { SmtpProvider } from "./smtp.provider.js";

import type { MailProvider } from "./mail.provider.js";
import type Redis from "ioredis";

const logger = new Logger("MailProviderFactory");

/**
 * Thrown at boot when `MAIL_PROVIDER` and the rest of the environment disagree.
 *
 * A misconfigured transport must be a startup failure, not a queue that quietly
 * fills with jobs nobody can deliver.
 */
export class MailProviderConfigError extends Error {
  public override readonly name = "MailProviderConfigError";
}

/**
 * Pick the transport for `MAIL_PROVIDER`.
 *
 * `@montaj/config` already refuses to load an environment where `MAIL_FROM` is
 * missing for `ses`/`smtp` or `SMTP_URL` is missing for `smtp`, so the checks
 * here are the belt to that braces: this function is also called directly by the
 * unit suite with hand-built environments.
 */
export function createMailProvider(env: Env, redis: Redis): MailProvider {
  switch (env.MAIL_PROVIDER) {
    case "ses": {
      const from = requireFrom(env);
      logger.log({ region: env.S3_REGION }, "mail transport: SES (credentials from the pod role)");
      return SesProvider.forRegion(env.S3_REGION, from);
    }
    case "smtp": {
      const from = requireFrom(env);
      const url = env.SMTP_URL;
      if (url === undefined) {
        throw new MailProviderConfigError('SMTP_URL is required when MAIL_PROVIDER is "smtp".');
      }
      // The URL carries credentials, so only its host reaches the log.
      logger.log({ host: hostOf(url) }, "mail transport: SMTP");
      return SmtpProvider.fromUrl(url, from);
    }
    case "dev": {
      if (process.env["NODE_ENV"] === "production") {
        throw new MailProviderConfigError(
          "MAIL_PROVIDER=dev writes to a Redis list instead of sending mail, which is never " +
            "right in production. Set MAIL_PROVIDER to ses or smtp.",
        );
      }
      logger.log("mail transport: development outbox (nothing is sent)");
      return new DevOutboxProvider(redis);
    }
  }
}

function requireFrom(env: Env): string {
  if (env.MAIL_FROM === undefined) {
    throw new MailProviderConfigError(
      `MAIL_FROM is required when MAIL_PROVIDER is "${env.MAIL_PROVIDER}".`,
    );
  }
  return env.MAIL_FROM;
}

/** Host of an `smtp://` URL, or `"invalid"` — never the credentials in it. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}
