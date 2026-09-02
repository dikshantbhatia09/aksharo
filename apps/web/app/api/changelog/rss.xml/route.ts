import { BRAND, brandUrl } from "@montaj/config";
import { NextResponse } from "next/server";

import { loadChangelogEntries } from "@/lib/content/loader";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The in-app changelog's RSS feed (brief §3). Served from `/updates` (the
 * marketing site already owns `/changelog` — see `app/(app)/updates/page.tsx`
 * for why this collection moved), one `<item>` per MDX entry, newest first.
 */
export function GET(): NextResponse {
  const entries = loadChangelogEntries();
  const items = entries
    .map((entry) => {
      const link = brandUrl(`/updates#${entry.version}`);
      const pubDate = new Date(`${entry.date}T00:00:00Z`).toUTCString();
      return `    <item>
      <title>${escapeXml(entry.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(entry.version)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(entry.body)}</description>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(`${BRAND.name} — What's new`)}</title>
    <link>${escapeXml(brandUrl("/updates"))}</link>
    <description>${escapeXml(`What shipped in ${BRAND.name}, newest first.`)}</description>
${items}
  </channel>
</rss>`;

  return new NextResponse(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
