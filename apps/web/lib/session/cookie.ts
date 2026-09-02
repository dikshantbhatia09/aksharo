import "server-only";

/**
 * Where the refresh token lives in the browser.
 *
 * Not `localStorage`, and not a JavaScript-readable cookie: the refresh token is
 * the long-lived credential (30-day family, CONTRACTS §5), and anything a script
 * can read, an injected script can exfiltrate (THREAT-MODEL T2). It lives in an
 * httpOnly cookie that only the route handlers in `app/api/session/` can see;
 * the access token stays in memory for its 15 minutes and is never persisted.
 *
 * `SameSite=Lax` rather than `Strict` because the OAuth callback and the magic
 * link are top-level navigations from another origin, and `Strict` would drop
 * the cookie on exactly the journeys that need it.
 */

import type { NextResponse } from "next/server";

export const SESSION_COOKIE = "aksharo_rt";

/** The family lives 30 days from issue and is not extended by rotation. */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Whether this request arrived over TLS.
 *
 * Keyed on the request rather than on `NODE_ENV`, because a production build
 * served over plain http — a local end-to-end run, a container behind a
 * TLS-terminating proxy that forwards http — would otherwise set `Secure` on an
 * origin that cannot carry it. Chromium tolerates that on 127.0.0.1; WebKit
 * drops the cookie, and the session silently never exists.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded !== null) return forwarded.split(",")[0]?.trim() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return true;
  }
}

export function setSessionCookie(
  response: NextResponse,
  refreshToken: string,
  secure: boolean,
): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: refreshToken,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(response: NextResponse, secure = false): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });
}

/**
 * Reject a request that did not come from this app.
 *
 * `POST /api/session` writes a session cookie, so a cross-site form post could
 * otherwise log a victim into the attacker's account and quietly collect
 * everything they then upload. There is no state-changing GET here, so an origin
 * check is sufficient and needs no token round-trip.
 */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";

  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
