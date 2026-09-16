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
 * Rotate the refresh token and hand back a fresh access token.
 *
 * This runs on the server because the refresh token is httpOnly: the browser
 * cannot read it and therefore cannot call `/auth/refresh` itself. Doing the
 * rotation in one place also means one writer for the cookie, which is what
 * makes the 60 s grace of CONTRACTS §5 behave — two tabs racing both get the
 * same replayed pair rather than one of them tripping reuse detection.
 *
 * Only a genuine `401` from upstream clears the cookie: that is the one status
 * `SessionService.refresh` (`apps/api/src/auth/session.service.ts`) uses for
 * "this refresh token is unknown, revoked, or past its absolute lifetime" --
 * every one of its thrown exceptions maps to `HttpStatus.UNAUTHORIZED`. Any
 * other non-2xx (`429` from this same route's own IP rate limit tripping
 * under concurrent tabs, a `5xx` blip, or a Cloudflare error page returned
 * while the API process is mid-restart) says nothing about whether the token
 * is still good, so the cookie survives it, exactly like the network-
 * unreachable branch below. Clearing it on *any* `!upstream.ok` used to throw
 * away a perfectly live 30-day session over a transient failure that had
 * nothing to do with the token -- confirmed live: a `sessions` row this
 * happened to had no `revokedAt` and an `expiresAt` weeks out, so the token
 * was never actually invalid, only the one HTTP round-trip that checked it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TokenResponseBody {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresIn?: unknown;
  workspaceId?: unknown;
  role?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { error: { code: "common/forbidden", message: "Cross-site request." } },
      { status: 403 },
    );
  }

  const store = await cookies();
  const refreshToken = store.get(SESSION_COOKIE)?.value;
  if (refreshToken === undefined || refreshToken === "") {
    return NextResponse.json(
      { error: { code: "auth/expired", message: "You are signed out." } },
      { status: 401 },
    );
  }

  const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";

  let upstream: Response;
  try {
    upstream = await fetch(new URL("/auth/refresh", apiOrigin), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ refreshToken }),
      cache: "no-store",
    });
  } catch {
    // The API being unreachable is not proof the session is gone, so the cookie
    // survives and the client retries.
    return NextResponse.json(
      { error: { code: "network/unreachable", message: "We could not reach the server." } },
      { status: 503 },
    );
  }

  if (upstream.status === 401) {
    const failure = new NextResponse(
      JSON.stringify({ error: { code: "auth/expired", message: "Your session has ended." } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
    clearSessionCookie(failure, isSecureRequest(request));
    return failure;
  }

  if (!upstream.ok) {
    // Not proof the token is dead -- a rate limit, a 5xx, or a gateway error
    // while the API restarts. Keep the cookie and let the client retry.
    return NextResponse.json(
      { error: { code: "network/unreachable", message: "We could not reach the server." } },
      { status: 503 },
    );
  }

  const tokens = (await upstream.json()) as TokenResponseBody;
  if (typeof tokens.accessToken !== "string" || typeof tokens.refreshToken !== "string") {
    return NextResponse.json(
      {
        error: { code: "network/malformed_response", message: "Unexpected reply from the server." },
      },
      { status: 502 },
    );
  }

  // The refresh token never leaves the server; only the 15-minute access token
  // is handed to the page.
  const response = NextResponse.json({
    accessToken: tokens.accessToken,
    expiresIn: typeof tokens.expiresIn === "number" ? tokens.expiresIn : 900,
    workspaceId: typeof tokens.workspaceId === "string" ? tokens.workspaceId : null,
    role: typeof tokens.role === "string" ? tokens.role : null,
  });
  setSessionCookie(response, tokens.refreshToken, isSecureRequest(request));
  return response;
}
