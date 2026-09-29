import { ClientReview } from "./client-review";

import type { Metadata } from "next";

import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";

/**
 * A client's review link (2026-10-03): `/share/review/:token`, where someone
 * with no account watches a run's clips on their phone and approves them or
 * asks for changes.
 *
 * Under `/share`, so it lives and dies with the public-links surface
 * (`shares.public`: the middleware answers 404 while it is off, and so does
 * this page) and `robots.ts` already keeps crawlers out. Its own metadata
 * repeats `noindex`, gives a chat preview nothing from the clips, and sends no
 * referrer: the page's address IS the credential, and a video request to the
 * media host must not carry it in a `Referer` header.
 */
export function generateMetadata(): Metadata {
  assertServerSurfaceEnabled("publicShares");
  return {
    title: "Review clips",
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
    openGraph: { title: "Review clips" },
  };
}

export default async function ClientReviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<React.JSX.Element> {
  assertServerSurfaceEnabled("publicShares");
  const { token } = await params;
  return <ClientReview token={token} />;
}
