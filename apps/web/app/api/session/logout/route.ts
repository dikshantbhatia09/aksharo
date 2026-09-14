import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { clearSessionCookie, isSameOrigin, isSecureRequest, SESSION_COOKIE } from "@/lib/session/cookie";

/**
 * Sign out: revoke the refresh-token family server-side, then drop the cookie.
 *
 * This route exists because the browser cannot do the first half. The refresh
 * token is httpOnly, so page code cannot read it — and the sign-out button used
 * to call `POST /auth/logout` with `refreshToken: ""`, which the API rejects as
 * too short (min 16), swallow the error, and then clear only the local cookie.
 * The family stayed live for its full 30 days. Anyone holding a token stolen
 * before "sign out" — an XSS payload, a shared machine, a stolen backup — kept
 * a working session, and the device list still showed it (launch-readiness
 * P0-06; OWASP Session Management: logout must invalidate the server-side
 * session, not just the client's copy of it).
 *
 * The cookie is dropped in every outcome, including an API error: a token the
 * server may no longer honour is worse than no token, and a user who pressed
 * sign out must end up signed out of this browser whatever else failed. The
 * response says which half succeeded so the caller can warn rather than claim a
 * clean sign-out it did not get.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { error: { code: "common/forbidden", message: "Cross-site request." } },
      { status: 403 },
    );
  }

  const store = await cookies();
  const refreshToken = store.get(SESSION_COOKIE)?.value;

  let revoked = false;
  if (refreshToken !== undefined && refreshToken !== "") {
    const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";
    try {
      const upstream = await fetch(new URL("/auth/logout", apiOrigin), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ refreshToken }),
        cache: "no-store",
      });
      // The API answers 204 for an unknown token too, deliberately: whether a
      // token was live must not be observable. Either way the family is gone.
      revoked = upstream.ok;
    } catch {
      // Network failure. The cookie still goes; `revoked: false` tells the
      // caller the server-side family may have survived.
      revoked = false;
    }
  } else {
    // No cookie: there is no family to revoke, so this is a clean sign-out.
    revoked = true;
  }

  const response = NextResponse.json(
    { revoked },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
  clearSessionCookie(response, isSecureRequest(request));
  return response;
}
