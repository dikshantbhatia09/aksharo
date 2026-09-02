import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  clearSessionCookie,
  isSameOrigin,
  isSecureRequest,
  SESSION_COOKIE,
  setSessionCookie,
} from "@/lib/session/cookie";

/**
 * The only two things the browser may do with a refresh token: hand one over
 * after a successful sign-in, and throw it away on sign-out. It can never read
 * one back.
 *
 * `POST` is called right after `/auth/login`, `/auth/verify-email`,
 * `/auth/magic-link/consume`, `/auth/oauth/complete` and `/auth/token/exchange`.
 * `DELETE` is called after `/auth/logout` has revoked the family server-side; it
 * clears the cookie even if that call failed, because a cookie the API no longer
 * honours is worse than no cookie.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionBody {
  refreshToken?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { error: { code: "common/forbidden", message: "Cross-site request." } },
      { status: 403 },
    );
  }

  let body: SessionBody;
  try {
    body = (await request.json()) as SessionBody;
  } catch {
    return NextResponse.json(
      { error: { code: "common/bad_request", message: "Expected JSON." } },
      { status: 400 },
    );
  }

  const refreshToken = body.refreshToken;
  if (typeof refreshToken !== "string" || refreshToken.length < 16 || refreshToken.length > 512) {
    return NextResponse.json(
      { error: { code: "common/validation_failed", message: "A refresh token is required." } },
      { status: 400 },
    );
  }

  const response = new NextResponse(null, { status: 204 });
  setSessionCookie(response, refreshToken, isSecureRequest(request));
  return response;
}

export async function DELETE(request: Request): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { error: { code: "common/forbidden", message: "Cross-site request." } },
      { status: 403 },
    );
  }
  const response = new NextResponse(null, { status: 204 });
  clearSessionCookie(response, isSecureRequest(request));
  return response;
}

/** Whether a session cookie exists. Never returns the token itself. */
export async function GET(): Promise<NextResponse> {
  const store = await cookies();
  return NextResponse.json({ authenticated: store.get(SESSION_COOKIE) !== undefined });
}
