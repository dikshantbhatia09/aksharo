import type { MailProviderName } from "@montaj/config";

/**
 * One message, as every transport receives it.
 *
 * Both bodies are always present. A text part is not a courtesy: a message with
 * only HTML scores worse with every spam filter, and the terminal-mail and
 * screen-reader minority is exactly the audience that notices.
 */
export interface MailMessage {
  /** A single recipient. Batching is not a thing here: one message, one mailbox. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * Provider-side labels for reporting (SES message tags, an `X-Tag` header on
   * SMTP). **Never** carries a secret or an address: SES surfaces tags in
   * CloudWatch, so a token in one is a token in a metric.
   */
  readonly tags?: Readonly<Record<string, string>>;
  /** Extra headers, e.g. `List-Unsubscribe` on the kinds that allow it. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Stable per (kind, recipient, subject-of-the-message) key. The consumer uses
   * it to make a retry at-most-once; a provider may use it as its own
   * deduplication handle.
   */
  readonly idempotencyKey: string;
  /**
   * Read **only** by {@link MailProviderName} `dev`, ignored by `ses` and `smtp`.
   *
   * A04 shipped a Redis outbox whose entries are `{to, template, token, link}`,
   * and its e2e suite completes real sign-up and magic-link flows by reading the
   * token straight out of it. A25 took delivery over, so it also inherited that
   * shape: without these three fields the outbox would still fill up and every
   * A04 flow test would stop being able to finish. Nothing outside development
   * ever looks at it, and no other transport is allowed to.
   */
  readonly devOutbox?: DevOutboxExtras;
}

export interface DevOutboxExtras {
  /** A04's template name (`email_verification`, `magic_link`, `device_approved`). */
  readonly template: string;
  /** The raw single-use token, so a developer can finish the flow with no mailbox. */
  readonly token?: string;
  /** The https link the recipient would have clicked. */
  readonly link?: string;
}

export interface MailSendResult {
  /** The transport's own id, when it has one. Logged; never shown to a user. */
  readonly providerMessageId?: string;
}

/**
 * The seam between "what to say" and "how it leaves the building".
 *
 * Three implementations, chosen by `MAIL_PROVIDER`: SES in the cloud (IRSA, no
 * key), SMTP for self-hosted installations and for Mailpit locally, and a Redis
 * outbox for a developer with no mail server at all.
 *
 * A `send` that rejects is retried by the consumer under the queue's backoff, so
 * an implementation must throw on a soft failure and must not swallow one.
 */
export interface MailProvider {
  readonly name: MailProviderName;
  send(message: MailMessage): Promise<MailSendResult>;
  /** Release any connection the transport holds. Called on shutdown. */
  close?(): Promise<void>;
}

/** Nest injection token for the selected {@link MailProvider}. */
export const MAIL_PROVIDER = Symbol("MAIL_PROVIDER");
