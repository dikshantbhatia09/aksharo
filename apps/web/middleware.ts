import { NextResponse } from "next/server";

import { surfaceEnabled } from "@montaj/config";

import { parseFlags } from "./lib/flags";

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

/**
 * A path is "under" a prefix only at a segment boundary -- plain
 * `pathname.startsWith(prefix)` would treat `/plugins` as under `/p` (C11:
 * added when the matcher grew to cover `/plugins`, which exposed that
 * `/pricing` and any other `/p*` marketing route would have silently been
 * caught by the same bug the moment it was ever added to `matcher` below).
 */
function isUnderPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const authenticated = request.cookies.get(SESSION_COOKIE) !== undefined;

  const flags = parseFlags(process.env["FEATURE_FLAGS_JSON"] ?? null);

  // Surface availability edge enforcement (RLS-006 fail-closed guardrail)
  if (isUnderPath(pathname, "/download") && !surfaceEnabled("desktop", flags)) {
    return new NextResponse(null, { status: 404 });
  }

  if (
    (isUnderPath(pathname, "/plugins") ||
      isUnderPath(pathname, "/plugins-app") ||
      isUnderPath(pathname, "/docs/plugins")) &&
    !surfaceEnabled("plugins", flags)
  ) {
    return new NextResponse(null, { status: 404 });
  }

  if (
    (isUnderPath(pathname, "/affiliate") || isUnderPath(pathname, "/r")) &&
    !surfaceEnabled("affiliates", flags)
  ) {
    return new NextResponse(null, { status: 404 });
  }

  if (isUnderPath(pathname, "/share") && !surfaceEnabled("publicShares", flags)) {
    return new NextResponse(null, { status: 404 });
  }

  if (
    isUnderPath(pathname, "/admin") &&
    !ADMIN_GATE_EXEMPT.some((prefix) => pathname === prefix) &&
    request.cookies.get(ADMIN_HINT_COOKIE) === undefined
  ) {
    return new NextResponse(null, { status: 404 });
  }

  if (!authenticated && PROTECTED.some((prefix) => isUnderPath(pathname, prefix))) {
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

  /**
   * "/plugins" is the same kind of dual screen (C11): `(site)/(marketing)/
   * plugins/page.tsx` answers it for a signed-out visitor, and Next.js
   * refuses two page files resolving the same path, so the signed-in
   * activation-card screen lives at the internal route `/plugins-app`
   * and is invisibly rewritten in, exactly like Home above. `/plugins/keys`
   * is unaffected -- there is no marketing page at that path to collide with.
   */
  if (authenticated && pathname === "/plugins") {
    const url = request.nextUrl.clone();
    url.pathname = "/plugins-app";
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
    "/plugins",
    "/plugins/:path*",
    "/plugins-app",
    "/plugins-app/:path*",
    "/docs/plugins",
    "/docs/plugins/:path*",
    "/download",
    "/download/:path*",
    "/affiliate",
    "/affiliate/:path*",
    "/r/:path*",
    "/share",
    "/share/:path*",
    "/login",
    "/signup",
    "/magic",
    "/admin/:path*",
  ],
};
