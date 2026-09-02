import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

import { parseSesEvent } from "./ses-event.js";
import { SnsMessageSchema, SnsVerificationError, verifySnsMessage } from "./sns-message.js";
import { AppException, ERROR_CODES, maskEmail } from "../../common/index.js";
import { SuppressionService } from "../suppression.service.js";

import type { CertificateFetcher } from "./sns-message.js";

/**
 * Injection token for the certificate fetcher.
 *
 * A port rather than a direct `fetch`, so the unit suite signs a fixture with a
 * throwaway key pair and verifies the real code path without a network call.
 */
export const CERTIFICATE_FETCHER = Symbol("SNS_CERTIFICATE_FETCHER");

/** What the endpoint did, so an operator can read it off a log line. */
export interface MailEventAck {
  readonly status: "ok";
  readonly handled: string;
  readonly suppressed: number;
  readonly released: number;
}

/**
 * `POST /internal/mail/events` — the SES bounce and complaint feed.
 *
 * Not behind {@link InternalSignatureGuard}: SNS is AWS's publisher, it will not
 * compute our HMAC, and it does not accept a shared secret. The SNS message
 * signature is the authentication instead, verified in `sns-message.ts` against a
 * certificate fetched from an `sns.<region>.amazonaws.com` URL and nowhere else.
 * A message that fails any part of that is a 401 and changes nothing — without
 * it, this route would let anyone stop mail to any address they can name.
 *
 * `SubscriptionConfirmation` is **verified and logged, not auto-confirmed**. The
 * confirmation is a one-time outbound GET to a URL that arrived in a request, and
 * an operator clicking "confirm subscription" in the console once per topic is a
 * better trade than a service that will call any URL AWS's signature vouches for.
 * The log line carries the topic ARN so the operator knows which one to confirm.
 */
@ApiExcludeController()
@Controller("internal/mail")
export class MailEventsController {
  private readonly logger = new Logger(MailEventsController.name);

  constructor(
    private readonly suppression: SuppressionService,
    @Inject(CERTIFICATE_FETCHER) private readonly fetchCertificate: CertificateFetcher,
  ) {}

  @Post("events")
  @HttpCode(HttpStatus.OK)
  async events(@Body() body: unknown): Promise<MailEventAck> {
    const parsed = SnsMessageSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppException(
        ERROR_CODES.badRequest,
        "Not an Amazon SNS message.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const message = parsed.data;

    try {
      await verifySnsMessage(message, this.fetchCertificate);
    } catch (error) {
      this.logger.warn(
        {
          topic: message.TopicArn,
          err: error instanceof SnsVerificationError ? error.message : "unknown",
        },
        "rejected an unverified SNS message",
      );
      throw new AppException(
        ERROR_CODES.unauthorized,
        "The SNS signature did not verify.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (message.Type !== "Notification") {
      this.logger.warn(
        { topic: message.TopicArn, type: message.Type },
        "SNS subscription message received; confirm it from the AWS console",
      );
      return { status: "ok", handled: message.Type, suppressed: 0, released: 0 };
    }

    const event = parseSesEvent(message.Message);
    let suppressed = 0;
    let released = 0;

    for (const recipient of event.recipients) {
      if (event.kind === "bounce" || event.kind === "complaint") {
        await this.suppression.suppress({
          email: recipient,
          permanence: event.permanence ?? "permanent",
          reason: event.reason ?? event.kind,
          source: `ses-${event.kind}`,
        });
        suppressed += 1;
        continue;
      }
      if (event.kind === "delivery" && (await this.suppression.releaseTransient(recipient))) {
        released += 1;
      }
    }

    this.logger.log(
      {
        kind: event.kind,
        recipients: event.recipients.map(maskEmail),
        suppressed,
        released,
      },
      "SES event processed",
    );

    return { status: "ok", handled: event.kind, suppressed, released };
  }
}
