import { NextResponse } from "next/server";

import { readRuntimeConfig } from "@/lib/runtime-config";

const FALLBACK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Aksharo status</title>
    <description>Could not reach the status API.</description>
  </channel>
</rss>
`;

/**
 * Proxies `apps/api/src/ops/status.controller.ts`'s `GET /ops/status/rss.xml`.
 *
 * A thin proxy rather than a second RSS renderer: the API already reads the
 * one `ops_status_snapshots` row this needs, and a second implementation here
 * would be the two-shapes-of-the-same-list drift the mirror pattern
 * (`content/site/privacy-notice-mirror.ts`) exists to avoid elsewhere. Unlike
 * that mirror, there is no `next build` ordering problem here — this is a
 * request-time route, not a static page — so proxying is strictly simpler
 * than mirroring.
 */
export async function GET(): Promise<NextResponse> {
  const { apiOrigin } = readRuntimeConfig();
  try {
    const response = await fetch(`${apiOrigin}/ops/status/rss.xml`, { cache: "no-store" });
    if (!response.ok) throw new Error(`status ${String(response.status)}`);
    const xml = await response.text();
    return new NextResponse(xml, {
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
    });
  } catch {
    return new NextResponse(FALLBACK_XML, {
      status: 502,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
    });
  }
}
