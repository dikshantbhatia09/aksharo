"use client";

/**
 * Error reporting, with the personal data taken out first.
 *
 * Aksharo handles client footage under NDA and transcripts of people talking, so
 * a stack trace that carries an email address, a bearer token or a signed media
 * URL is a data leak with a nice UI on top (THREAT-MODEL T18, T21). Everything
 * that leaves this module goes through `scrub` first.
 *
 * `@sentry/browser` rather than `@sentry/nextjs`: this work package owns the
 * browser surface only, and the Next SDK's build plugin and server
 * instrumentation belong with the deployment work (X05).
 */

interface SentryEventLike {
  request?: { url?: string; headers?: Record<string, string>; cookies?: unknown };
  user?: { email?: string; ip_address?: string; username?: string; id?: string };
  message?: string;
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
  exception?: { values?: { value?: string }[] };
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const QUERY_SECRET =
  /([?&](?:token|code|access_token|refresh_token|signature|X-Amz-Signature)=)[^&#]+/gi;

/** Replace anything that identifies a person or authorises a request. */
export function scrubText(value: string): string {
  return value
    .replace(EMAIL, "[email]")
    .replace(JWT, "[jwt]")
    .replace(BEARER, "$1[token]")
    .replace(QUERY_SECRET, "$1[redacted]");
}

/** Strip an event before it is sent. Exported so the rule is testable. */
export function scrubEvent<T extends SentryEventLike>(event: T): T {
  if (event.request?.url !== undefined) event.request.url = scrubText(event.request.url);
  if (event.request !== undefined) {
    delete event.request.cookies;
    delete event.request.headers;
  }
  if (event.user !== undefined) {
    // The user id is a ULID and identifies the account without revealing a
    // person; the address, name and IP do the opposite.
    event.user = event.user.id === undefined ? {} : { id: event.user.id };
  }
  if (event.message !== undefined) event.message = scrubText(event.message);
  for (const value of event.exception?.values ?? []) {
    if (value.value !== undefined) value.value = scrubText(value.value);
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message !== undefined) crumb.message = scrubText(crumb.message);
    delete crumb.data;
  }
  return event;
}

let started = false;

export function initObservability(dsn: string | null, environment: string): void {
  if (started || dsn === null || typeof window === "undefined") return;
  started = true;

  void import("@sentry/browser")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        environment,
        // No performance traces and no session replay: both would record URLs
        // and DOM content from a workspace we have no right to store.
        tracesSampleRate: 0,
        sendDefaultPii: false,
        beforeSend: (event) => scrubEvent(event as SentryEventLike) as never,
        beforeBreadcrumb: (crumb) => {
          if (crumb.type === "http" && typeof crumb.data?.["url"] === "string") {
            crumb.data["url"] = scrubText(crumb.data["url"]);
          }
          return crumb;
        },
      });
    })
    .catch(() => {
      started = false;
    });
}

/** Test seam. */
export function __resetObservabilityForTests(): void {
  started = false;
}
