import { ShareViewer } from "./share-viewer";

import type { Metadata } from "next";

import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";

/**
 * The public review surface (B15 brief §1, §3): `/share/:token`.
 *
 * `robots.ts` already disallows `/share` for every crawler (D70: "review
 * links are never indexable"); this page's own metadata repeats `noindex` so
 * a link shared outside a search engine's own crawl (a chat preview, an
 * archive) still carries the instruction.
 */
export function generateMetadata(): Metadata {
  assertServerSurfaceEnabled("publicShares");
  return {
    title: "Shared review",
    robots: { index: false, follow: false, nocache: true },
    // F-504: no thumbnail in a link preview unless the owner opts in — this
    // page emits no `openGraph.images` at all, so a chat client falls back to
    // its own generic link card instead of pulling a frame from the project.
    openGraph: { title: "Shared review" },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<React.JSX.Element> {
  assertServerSurfaceEnabled("publicShares");
  const { token } = await params;
  return <ShareViewer token={token} />;
}
