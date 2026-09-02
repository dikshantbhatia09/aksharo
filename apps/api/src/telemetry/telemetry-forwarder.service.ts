import { Injectable, Logger } from "@nestjs/common";

/**
 * Server-side-only forwarding to Sentry (crashes) and PostHog (events), behind
 * the optional `SENTRY_DSN`/`POSTHOG_KEY` env vars (`.env.example`, both blank
 * locally). The brief is explicit: "never directly to a third-party from the
 * client" — the client only ever talks to our own API; this is the one place
 * that talks to a vendor, and only when an operator has opted in by setting a
 * key.
 *
 * Best-effort: a forwarding failure is logged and swallowed, exactly like
 * `ProductEventsService.record` — losing a copy in Sentry/PostHog must never
 * fail the API call that already durably wrote the row.
 */
@Injectable()
export class TelemetryForwarderService {
  private readonly logger = new Logger(TelemetryForwarderService.name);

  private get sentryDsn(): string | undefined {
    const value = process.env["SENTRY_DSN"];
    return value === undefined || value === "" ? undefined : value;
  }

  private get posthogKey(): string | undefined {
    const value = process.env["POSTHOG_KEY"];
    return value === undefined || value === "" ? undefined : value;
  }

  private get posthogHost(): string {
    const value = process.env["POSTHOG_HOST"];
    return value === undefined || value === "" ? "https://eu.i.posthog.com" : value;
  }

  get sentryEnabled(): boolean {
    return this.sentryDsn !== undefined;
  }

  get posthogEnabled(): boolean {
    return this.posthogKey !== undefined;
  }

  /** Forwards one event to PostHog, when configured. Never throws. */
  async forwardEvent(input: {
    readonly kind: string;
    readonly distinctId: string;
    readonly props: Record<string, unknown>;
    readonly at: string;
  }): Promise<void> {
    const key = this.posthogKey;
    if (key === undefined) return;
    try {
      await fetch(`${this.posthogHost}/capture/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          event: input.kind,
          distinct_id: input.distinctId,
          properties: input.props,
          timestamp: input.at,
        }),
      });
    } catch (error) {
      this.logger.warn({ error, kind: input.kind }, "PostHog forward failed");
    }
  }

  /**
   * Forwards a crash report as a Sentry event, when configured. Uses the
   * minimal envelope format rather than the full `@sentry/node` SDK: this
   * server already has a redacted stack string, not a live exception object,
   * so the SDK's own capture APIs would add nothing but the dependency.
   */
  async forwardCrash(input: {
    readonly crashReportId: string;
    readonly clientKind: string;
    readonly appVersion: string;
    readonly osVersion: string;
    readonly stack: string;
  }): Promise<void> {
    const dsn = this.sentryDsn;
    if (dsn === undefined) return;
    try {
      const endpoint = sentryEnvelopeEndpoint(dsn);
      if (endpoint === undefined) return;
      const now = new Date().toISOString();
      const event = {
        event_id: input.crashReportId.padEnd(32, "0").slice(0, 32),
        timestamp: now,
        platform: "other",
        release: input.appVersion,
        tags: { clientKind: input.clientKind, osVersion: input.osVersion },
        exception: { values: [{ type: "CrashReport", value: input.stack.slice(0, 8_192) }] },
      };
      const envelope = [
        JSON.stringify({ event_id: event.event_id, sent_at: now }),
        JSON.stringify({ type: "event" }),
        JSON.stringify(event),
      ].join("\n");
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope" },
        body: envelope,
      });
    } catch (error) {
      this.logger.warn({ error, crashReportId: input.crashReportId }, "Sentry forward failed");
    }
  }
}

/** `https://<key>@<host>/<project>` -> `https://<host>/api/<project>/envelope/`. */
export function sentryEnvelopeEndpoint(dsn: string): string | undefined {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, "");
    if (projectId === "") return undefined;
    return `${url.protocol}//${url.host}/api/${projectId}/envelope/`;
  } catch {
    return undefined;
  }
}
