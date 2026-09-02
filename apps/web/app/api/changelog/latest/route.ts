import { NextResponse } from "next/server";

import { loadChangelogEntries } from "@/lib/content/loader";

/**
 * The newest changelog entry, as JSON — the one piece of MDX-derived data a
 * *client* component needs (`WhatsNewModal`, mounted in the app shell). The
 * MDX loader is fs-based and server-only, so a client component cannot call
 * it directly; this tiny route is the seam, the same shape `/help/search-index`
 * would be for the help search index.
 */
export function GET(): NextResponse {
  const [latest] = loadChangelogEntries();
  if (latest === undefined) {
    return NextResponse.json({ version: null, title: null, tags: [] });
  }
  return NextResponse.json({ version: latest.version, title: latest.title, tags: latest.tags });
}
