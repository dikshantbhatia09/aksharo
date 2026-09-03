import "server-only";

/**
 * A **routing hint**, not a credential — the server-side half of B13b's
 * admin-console gate (CONTRACTS §5 note, middleware.ts's own doc comment for
 * the product session cookie: "middleware is a routing decision, not an
 * authorisation one").
 *
 * The real admin credential (a `kind: "admin"` access token) lives only in
 * `sessionStorage` (`admin-session.ts`'s own doc comment explains why: a
 * 30-minute, TOTP-gated token that must not survive a tab close, and must
 * never be readable by a script the way a plain cookie is by nothing but
 * name). This cookie carries no token and no role information — it is a
 * boolean, httpOnly so a script cannot forge its own "yes" to the gate, set
 * for the same 30 minutes step-up mints for, and it exists purely so
 * `middleware.ts` can 404 `/admin/**` for a visitor who has never stepped up,
 * before any admin HTML — even the "step up" screen's own bundle — reaches
 * them. `AdminGuard` on the API is and remains the actual authorization; a
 * forged or replayed cookie gets a visitor nothing past the studio's own
 * "Admin step-up required" screen, because every panel's first fetch still
 * needs a real bearer token the guard checks against `admin_roles` itself.
 */

import type { NextResponse } from "next/server";

export const ADMIN_HINT_COOKIE = "aksharo_admin_hint";

/** Matches the 30-minute `kind: "admin"` token lifetime (CONTRACTS §5). */
const MAX_AGE_SECONDS = 30 * 60;

export function setAdminHintCookie(response: NextResponse, secure: boolean): void {
  response.cookies.set({
    name: ADMIN_HINT_COOKIE,
    value: "1",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearAdminHintCookie(response: NextResponse, secure = false): void {
  response.cookies.set({
    name: ADMIN_HINT_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });
}
