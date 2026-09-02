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

/**
 * B13b: the `(admin)` route group's server-side gate (this WP's brief §4).
 * A visitor with no admin step-up (`ADMIN_HINT_COOKIE` — see
 * `lib/admin/admin-hint-cookie.ts` for why this is a routing hint and not a
 * credential) gets a plain 404 rather than a redirect to a step-up screen,
 * so `/admin/**` does not announce its own existence to anyone who has not
 * already stepped up once. `/admin/step-up` itself is exempt — it is the
 * page that mints the hint in the first place. (`(admin)/ui-kit/**` shares
 * the route group's layout for component review only; a Next.js route
 * group adds nothing to the URL, so those pages are served from `/ui-kit`,
 * outside this gate's `/admin` prefix, and carry no admin data.)
 *
 * This is routing only, same as the rest of this file's own doc comment
 * says: `AdminGuard` on the API is and remains the real authorization check,
 * re-verified on every admin request against `admin_roles` in the database.
 */
const ADMIN_HINT_COOKIE = "aksharo_admin_hint";
const ADMIN_GATE_EXEMPT = ["/admin/step-up"];

/**
 * Everything behind a session. `/device` approves a sign-in, so it counts.
 *
 * `/home` is the authenticated dashboard's real route (A14); it is never a
 * link anyone follows on purpose (see the "/" rewrite below), but it must
 * still refuse a signed-out visitor who types the URL directly, the same as
 * every other route here. `/p` (A15's editor route, 08 §4) joined it so an
 * unauthenticated request redirects before any HTML ships, matching every
 * other route the shell protects — `AppShell` already refuses it
 * client-side, but that alone flashes the shell first.
 */
const PROTECTED = ["/studio", "/settings", "/onboarding", "/device", "/home", "/projects", "/p"];

/** Signed-in users have no business on these. */
const AUTH_ONLY = ["/login", "/signup", "/magic"];

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const authenticated = request.cookies.get(SESSION_COOKIE) !== undefined;

  if (
    pathname.startsWith("/admin") &&
    !ADMIN_GATE_EXEMPT.some((prefix) => pathname === prefix) &&
    request.cookies.get(ADMIN_HINT_COOKIE) === undefined
  ) {
    return new NextResponse(null, { status: 404 });
  }

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

  /**
   * "/" is two different screens depending on who is looking (08 §3 lists
   * `/` as Home's own route, and the marketing site's own homepage at
   * `(site)/(marketing)/page.tsx` also answers "/" for a signed-out visitor —
   * Next.js refuses to build two page files that resolve the same path, so
   * this rewrite is what makes both true at once). An authenticated request for
   * "/" is invisibly served from `(app)/home/page.tsx`; the browser's address
   * bar never changes, which is what lets the sidebar's Home link keep
   * pointing at plain "/".
   */
  if (authenticated && pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/home";
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Only the routes above, plus "/" for the Home rewrite. `/api/session/*` in
   * particular must never be intercepted: it is how a browser with no access
   * token gets one, and redirecting it would make signing in impossible.
   */
  matcher: [
    "/",
    "/studio/:path*",
    "/settings/:path*",
    "/onboarding/:path*",
    "/device",
    "/home/:path*",
    "/projects/:path*",
    "/p/:path*",
    "/login",
    "/signup",
    "/magic",
    "/admin/:path*",
  ],
};
