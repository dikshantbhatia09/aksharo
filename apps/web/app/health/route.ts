import { NextResponse } from "next/server";

import { APP_VERSION } from "@/lib/version";

/** Never cached: a load balancer must see live state, not a build-time answer. */
export const dynamic = "force-dynamic";

/** Liveness probe, mirroring the API's `GET /health`. */
export function GET(): NextResponse<{ status: "ok"; version: string }> {
  return NextResponse.json({ status: "ok", version: APP_VERSION } as const);
}
