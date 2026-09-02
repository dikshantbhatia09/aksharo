import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { Logger } from "@nestjs/common";

import type { MailProviderName } from "@montaj/config";

import type { MailMessage, MailProvider, MailSendResult } from "./mail.provider.js";

/**
 * The one SES call this module makes, as an interface, so the unit suite can
 * assert on the request the adapter builds without an AWS account.
 */
export interface SesClient {
  send(command: SendEmailCommand): Promise<{ MessageId?: string }>;
  destroy?(): void;
}

/**
 * SES message tags are `[A-Za-z0-9_-]` only, and SES rejects the whole request
 * over one bad character. Anything else becomes `_`, and an empty result is
 * dropped rather than sent as an empty tag.
 */
export function sesTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

/**
 * `MAIL_PROVIDER=ses`: AWS SES v2 through the SDK v3.
 *
 * **No credentials are passed.** The client falls through to the default provider
 * chain, which on EKS is the pod's IRSA role — the whole reason there is no mail
 * access key in CONTRACTS section 1. The region is `S3_REGION`, so mail leaves
 * from the same region the media lives in (THREAT-MODEL T24) rather than from
 * whatever `AWS_REGION` a node happens to carry.
 *
 * Configuration sets and event destinations are Terraform's business; this class
 * only sends. Bounces and complaints come back through the SNS webhook in
 * `../sns/`, not through this call's response.
 */
export class SesProvider implements MailProvider {
  readonly name: MailProviderName = "ses";
  private readonly logger = new Logger(SesProvider.name);

  constructor(
    private readonly client: SesClient,
    private readonly from: string,
  ) {}

  static forRegion(region: string, from: string): SesProvider {
    return new SesProvider(new SESv2Client({ region }) as unknown as SesClient, from);
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const tags = Object.entries(message.tags ?? {})
      .map(([name, value]) => ({ Name: sesTagValue(name), Value: sesTagValue(value) }))
      .filter((tag) => tag.Name !== "" && tag.Value !== "");

    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [message.to] },
        EmailTags: tags.length === 0 ? undefined : tags,
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              Html: { Data: message.html, Charset: "UTF-8" },
            },
            // `Simple` carries no header list, so `List-Unsubscribe` rides along
            // as a header on the SES v2 request itself.
            Headers:
              message.headers === undefined
                ? undefined
                : Object.entries(message.headers).map(([name, value]) => ({
                    Name: name,
                    Value: value,
                  })),
          },
        },
      }),
    );

    this.logger.debug({ messageId: result.MessageId }, "message accepted by SES");
    return result.MessageId === undefined ? {} : { providerMessageId: result.MessageId };
  }

  close(): Promise<void> {
    this.client.destroy?.();
    return Promise.resolve();
  }
}
