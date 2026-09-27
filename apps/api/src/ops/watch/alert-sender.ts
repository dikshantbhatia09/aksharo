import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { alertWebhookSetting, type AlertWebhookSetting } from "../../config/ops-env.js";

/** ntfy's five priorities: 1 min, 2 low, 3 default, 4 high, 5 urgent. */
export type AlertPriority = 1 | 2 | 3 | 4 | 5;

/** One notification, already composed. Ids and counts only (see {@link scrub}). */
export interface OpsAlert {
  readonly title: string;
  readonly body: string;
  readonly priority: AlertPriority;
  /** ntfy tags: emoji short codes render as an icon, anything else as a label. */
  readonly tags: readonly string[];
}

export interface AlertSenderOptions {
  readonly setting: AlertWebhookSetting;
  readonly fetch: typeof fetch;
}

/** DI token for {@link AlertSenderOptions}; tests construct the sender directly. */
export const ALERT_SENDER_OPTIONS = Symbol("ALERT_SENDER_OPTIONS");

/** The production options: `ALERT_WEBHOOK_URL` and the platform `fetch`. */
export function alertSenderOptions(): AlertSenderOptions {
  return { setting: alertWebhookSetting(), fetch: globalThis.fetch.bind(globalThis) };
}

/** A phone notification must not hold the watch up; ntfy answers in well under a second. */
const SEND_TIMEOUT_MS = 10_000;

/** ntfy caps a message at 4 KiB; past it the body becomes an attachment nobody opens. */
const MAX_BODY_CHARS = 3_500;

const MAX_TITLE_CHARS = 200;

/**
 * Posts operational alerts to an ntfy topic (owner decision 2026-09-27): the body
 * is plain text, and `Title`, `Priority` and `Tags` ride as headers — ntfy's own
 * publish format, so no client library and nothing to keep in step.
 *
 * **With no `ALERT_WEBHOOK_URL` it logs instead**, at `warn` for anything high or
 * urgent, so a deployment without a destination still has the record in its log
 * and the watch's de-duplication still keeps that log readable. An invalid value
 * logs the same way and says, once, what was wrong with it — never the value: an
 * ntfy topic name is the only secret between an outsider and every alert.
 *
 * Every alert is logged either way, so the log is the complete history even when
 * the phone missed one.
 */
@Injectable()
export class AlertSender implements OnModuleInit {
  private readonly logger = new Logger("OpsAlerts");

  constructor(@Inject(ALERT_SENDER_OPTIONS) private readonly options: AlertSenderOptions) {}

  /** Where alerts go. */
  get destination(): "webhook" | "log" {
    return this.options.setting.kind === "ok" ? "webhook" : "log";
  }

  onModuleInit(): void {
    const setting = this.options.setting;
    if (setting.kind === "ok") {
      this.logger.log(`ops alerts go to a webhook on ${setting.url.host}`);
    } else if (setting.kind === "invalid") {
      this.logger.error(
        { problem: setting.problem },
        "ALERT_WEBHOOK_URL is not usable; ops alerts are written to this log only",
      );
    } else {
      this.logger.warn("ALERT_WEBHOOK_URL is not set; ops alerts are written to this log only");
    }
  }

  /**
   * Deliver one alert. `true` when it reached the destination (or the log, when
   * the log is the destination); `false` when the webhook refused it or could not
   * be reached, so the caller can try again on its next pass. Never throws.
   */
  async send(alert: OpsAlert): Promise<boolean> {
    const title = headerSafe(scrub(alert.title)).slice(0, MAX_TITLE_CHARS);
    const body = truncate(scrub(alert.body), MAX_BODY_CHARS);
    const record = { title, priority: alert.priority, tags: alert.tags, body };
    if (alert.priority >= 4) this.logger.warn(record, "ops alert");
    else this.logger.log(record, "ops alert");

    const setting = this.options.setting;
    if (setting.kind !== "ok") return true;

    try {
      const response = await this.options.fetch(setting.url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Title: title,
          Priority: String(alert.priority),
          Tags: alert.tags.map(headerSafe).join(","),
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn({ status: response.status, title }, "ops alert refused by the webhook");
        return false;
      }
      return true;
    } catch (error) {
      // The URL is deliberately not logged: it is the topic's secret.
      this.logger.warn(
        { title, err: error instanceof Error ? error.name : "unknown" },
        "ops alert could not be delivered",
      );
      return false;
    }
  }
}

/**
 * The last line of defence against a secret in an alert. Alerts are composed
 * from ids, queue names, error codes, counts and durations only, but a phone
 * notification is the one place this product's operational data leaves the
 * machine, so anything that looks like a URL (a signed media URL, a webhook)
 * or a long opaque token (a key, a signature, a JWT segment) is replaced before
 * it goes. ULIDs (26 characters) and error codes pass untouched.
 */
export function scrub(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, "[redacted]");
}

/** HTTP header values are Latin-1 without control characters; alert titles are kept to ASCII. */
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 16)}\n[... truncated]`;
}
