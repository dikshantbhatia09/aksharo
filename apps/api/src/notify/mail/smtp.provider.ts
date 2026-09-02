import { Logger } from "@nestjs/common";
import { createTransport } from "nodemailer";

import type { MailProviderName } from "@montaj/config";

import type { MailMessage, MailProvider, MailSendResult } from "./mail.provider.js";

/**
 * The slice of nodemailer this module uses, as an interface, so the unit suite
 * can substitute a transport without a socket anywhere.
 */
export interface SmtpTransport {
  sendMail(options: Record<string, unknown>): Promise<{ messageId?: string }>;
  close?(): void;
}

/**
 * `MAIL_PROVIDER=smtp`: any SMTP server, from `SMTP_URL`.
 *
 * Two audiences: a self-hosted installation that already has a relay, and a
 * developer running Mailpit (`docker compose --profile mail up -d`) who wants to
 * read the rendered HTML in something that renders HTML.
 *
 * Connections are pooled and the transport is long-lived — a per-message
 * connection would spend more time on TLS than on the message — and closed on
 * shutdown so a redeploy does not leave sockets in the relay's table.
 */
export class SmtpProvider implements MailProvider {
  readonly name: MailProviderName = "smtp";
  private readonly logger = new Logger(SmtpProvider.name);

  constructor(
    private readonly transport: SmtpTransport,
    private readonly from: string,
  ) {}

  /** Build one from `SMTP_URL`. Separate from the constructor so tests inject. */
  static fromUrl(url: string, from: string): SmtpProvider {
    const options = parseSmtpUrl(url);
    const transport = createTransport({
      ...options,
      // Pooled: a per-message connection would spend more time on TLS than on
      // the message, and a relay counts connections.
      pool: true,
      maxConnections: 4,
      // A relay that has gone away must fail the job so the queue retries it,
      // rather than holding the worker slot until something times out.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return new SmtpProvider(transport as unknown as SmtpTransport, from);
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const result = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: {
        ...(message.headers ?? {}),
        // Not a tracking header: it is the queue's idempotency key, which is what
        // lets an operator tie a message in the relay's log back to a job.
        "X-Aksharo-Message-Key": message.idempotencyKey,
      },
    });
    this.logger.debug({ messageId: result.messageId }, "message accepted by the relay");
    return result.messageId === undefined ? {} : { providerMessageId: result.messageId };
  }

  close(): Promise<void> {
    this.transport.close?.();
    return Promise.resolve();
  }
}

export interface SmtpConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth?: { readonly user: string; readonly pass: string };
}

/**
 * `smtp://user:pass@host:port` / `smtps://…` → connection options.
 *
 * Parsed here rather than handed to nodemailer as a string because the string
 * overload is not in the published types and because these are the four decisions
 * worth being explicit about: `smtps` means TLS from the first byte, `smtp` means
 * STARTTLS if the server offers it, the default ports are 465 and 587, and
 * credentials are URL-decoded (a password with a `@` in it is common and would
 * otherwise silently split the host).
 */
export function parseSmtpUrl(value: string): SmtpConnectionOptions {
  const url = new URL(value);
  const secure = url.protocol === "smtps:";
  const port = url.port === "" ? (secure ? 465 : 587) : Number(url.port);
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  return {
    host: url.hostname,
    port,
    secure,
    ...(user === "" ? {} : { auth: { user, pass } }),
  };
}
