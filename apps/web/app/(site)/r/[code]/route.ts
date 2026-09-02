import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { readRuntimeConfig } from "@/lib/runtime-config";

/**
 * `/r/<code>` (brief §2): the affiliate landing link. Sets a first-party,
 * 60-day, last-click cookie and records a click against the API, then
 * redirects to sign-up with the code carried through as a query param so
 * "code entered at sign-up" (the higher-precedence path) still works even
 * when the visitor clears cookies before completing sign-up.
 *
 * `route.ts`, not a page, because there is nothing to render — this is pure
 * redirect-with-side-effect, the same shape `apps/web/app/health/route.ts`
 * takes for a non-page endpoint.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const AFFILIATE_COOKIE_NAME = "aksh_aff";
export const AFFILIATE_COOKIE_DAYS = 60;

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code: rawCode } = await context.params;
  const code = rawCode.trim().toUpperCase();
  const url = new URL(request.url);

  if (!/^[0-9A-Z]{4,16}$/.test(code)) {
    return NextResponse.redirect(new URL("/signup", url.origin), { status: 302 });
  }

  const config = readRuntimeConfig();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const userAgent = request.headers.get("user-agent") ?? "";
  const ipHash = ip === undefined || ip === "" ? undefined : hashOf(ip);
  const deviceHash = userAgent === "" ? undefined : hashOf(userAgent);

  let attributed = false;
  try {
    const response = await fetch(`${config.apiOrigin}/affiliate/r/click`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, ipHash, deviceHash }),
      cache: "no-store",
    });
    if (response.ok) {
      const body = (await response.json()) as { attributed: boolean };
      attributed = body.attributed;
    }
  } catch {
    // A click that fails to record must never block the redirect — the
    // visitor still reaches sign-up, and "code entered at sign-up" is the
    // higher-precedence attribution path anyway (`attribution.ts`).
  }

  const redirectTo = new URL(`/signup?ref=${encodeURIComponent(code)}`, url.origin);
  const response = NextResponse.redirect(redirectTo, { status: 302 });

  if (attributed) {
    response.cookies.set(AFFILIATE_COOKIE_NAME, code, {
      maxAge: AFFILIATE_COOKIE_DAYS * 24 * 60 * 60,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
    });
  }

  return response;
}
