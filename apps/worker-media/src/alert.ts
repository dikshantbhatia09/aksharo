import { describeError } from "./errors.js";
import { logger } from "./logger.js";

/**
 * Operational alerts from this process, to the ntfy topic in
 * `ALERT_WEBHOOK_URL` (owner decision 2026-09-27: a POST with a plain-text
 * body and `Title` / `Priority` / `Tags` headers).
 *
 * The API's ops watch alerts on what the database shows. Two things only this
 * process knows, and both used to be silent:
 *
 * - **It refused to start.** The workers are started detached, so an acquire
 *   worker that fails its boot check — a plugin, a missing challenge solver, a
 *   runtime path that is wrong — just is not there, and acquisitions sit
 *   `queued` while every health check stays green: the shape of the
 *   2026-09-16 worker-media incident (CLAUDE.md §1).
 * - **Jobs are waiting for disk** (`disk.ts`). Their rows stay `queued`, which
 *   is the truth, and until now a warn line was the only other sign.
 *
 * Never throws, and never waits long: an alert that cannot be sent is logged,
 * and the work goes on. The URL is never logged — an ntfy topic name is the
 * only thing standing between it and anyone who wants to post to it.
 */

export type AlertPriority = "default" | "high" | "urgent";

export interface Alert {
  readonly title: string;
  readonly body: string;
  readonly priority: AlertPriority;
  readonly tags: readonly string[];
}

/** How long one alert may take. A worker waiting on ntfy is a worker not working. */
export const ALERT_TIMEOUT_MS = 5_000;

/**
 * `ALERT_WEBHOOK_URL`, when it is one to send to: `https`, or `http` to this
 * machine (a local relay), with no credentials in it. `null` for unset;
 * `"invalid"` for anything else, which is ignored rather than refused — a
 * typo in an alert URL must not stop a worker.
 */
export function alertTarget(raw: string | undefined): URL | null | "invalid" {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "invalid";
  if (url.username !== "" || url.password !== "") return "invalid";
  return url;
}

/** An HTTP header value: printable ASCII only, and short. */
function headerValue(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
}

export class AlertSender {
  private readonly sentAt = new Map<string, number>();

  constructor(
    private readonly target: URL | null,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  /** From the raw setting; an unusable one is said once, here, and then ignored. */
  static fromSetting(
    raw: string | undefined,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ): AlertSender {
    const target = alertTarget(raw);
    if (target === "invalid") {
      logger.warn(
        "ALERT_WEBHOOK_URL is not an https URL (or http to this machine); alerts go to this log only",
      );
      return new AlertSender(null, fetchImpl);
    }
    return new AlertSender(target, fetchImpl);
  }

  /** Send one alert. True when ntfy took it; false when there is nowhere to send, or it failed. */
  async send(alert: Alert): Promise<boolean> {
    if (this.target === null) {
      logger.warn("alert (no ALERT_WEBHOOK_URL)", { title: alert.title, body: alert.body });
      return false;
    }
    try {
      const response = await this.fetchImpl(this.target, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Title: headerValue(alert.title),
          Priority: alert.priority,
          Tags: headerValue(alert.tags.join(",")),
        },
        body: alert.body.slice(0, 4_000),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn("alert not accepted", { title: alert.title, status: response.status });
        return false;
      }
      return true;
    } catch (error) {
      logger.warn("alert not sent", { title: alert.title, error: describeError(error) });
      return false;
    }
  }

  /**
   * Send `alert` unless one under the same `key` went in the last
   * `intervalMs` — a condition that lasts is one alert an hour, not one a
   * minute. The interval starts when the alert is attempted, so an ntfy that
   * is down is not asked every minute either.
   */
  async sendAtMostEvery(key: string, intervalMs: number, alert: Alert): Promise<boolean> {
    const now = Date.now();
    const last = this.sentAt.get(key);
    if (last !== undefined && now - last < intervalMs) return false;
    this.sentAt.set(key, now);
    return this.send(alert);
  }
}
