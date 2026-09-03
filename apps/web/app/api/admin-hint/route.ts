import { NextResponse } from "next/server";

import { clearAdminHintCookie, setAdminHintCookie } from "@/lib/admin/admin-hint-cookie";
import { isSameOrigin, isSecureRequest } from "@/lib/session/cookie";

/**
 * Sets or clears the admin routing-hint cookie (`admin-hint-cookie.ts`).
 *
 * `POST` right after a successful `POST /admin/auth/step-up` (see
 * `admin/step-up/page.tsx`); `DELETE` when the admin session ends, either
 * explicitly ("End admin session" in `AdminShell`) or by the 30-minute
 * token simply expiring — the cookie carries its own matching `maxAge`, so
 * an unclearer expiry is still safe.
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
  const response = new NextResponse(null, { status: 204 });
  setAdminHintCookie(response, isSecureRequest(request));
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
  clearAdminHintCookie(response, isSecureRequest(request));
  return response;
}
