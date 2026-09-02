import { NextResponse } from "next/server";

import type { NextRequest } from "next/server";

/**
 * Keep signed-out visitors out of the studio before any HTML is sent.
 *
 * This is a **routing** decision, not an authorisation one: the presence of a
 * session cookie is not proof the family is still alive, so every API call is
 * still authenticated on the server and the shell re-checks by rotating on
 * mount. What the middleware buys is a correct first paint — no flash of an
 * empty sidebar before a client-side redirect.
 */

const SESSION_COOKIE = "aksharo_rt";

/** Everything behind a session. `/device` approves a sign-in, so it counts. */
const PROTECTED = ["/studio", "/settings", "/onboarding", "/device"];

/** Signed-in users have no business on these. */
const AUTH_ONLY = ["/login", "/signup", "/magic"];

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const authenticated = request.cookies.get(SESSION_COOKIE) !== undefined;

  if (!authenticated && PROTECTED.some((prefix) => pathname.startsWith(prefix))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  if (authenticated && AUTH_ONLY.some((prefix) => pathname === prefix)) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Only the routes above. `/api/session/*` in particular must never be
   * intercepted: it is how a browser with no access token gets one, and
   * redirecting it would make signing in impossible.
   */
  matcher: [
    "/studio/:path*",
    "/settings/:path*",
    "/onboarding/:path*",
    "/device",
    "/login",
    "/signup",
    "/magic",
  ],
};
