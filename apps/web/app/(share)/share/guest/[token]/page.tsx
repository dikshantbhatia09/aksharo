import { GuestPageView } from "./guest-page";

import type { Metadata } from "next";

import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";

/**
 * A guest's page (2026-10-05): `/share/guest/:token`, where someone a podcaster
 * had on their show downloads the clips they appear in, ready to repost, with
 * no account.
 *
 * Under `/share`, so it lives and dies with the public-links surface
 * (`shares.public`: the middleware answers 404 while it is off, and so does
 * this page) and `robots.ts` already keeps crawlers out. Its own metadata
 * repeats `noindex`, gives a chat preview nothing from the clips, and sends no
 * referrer: the page's address IS the credential, and a request for a file on
 * the media host must not carry it in a `Referer` header.
 */
export function generateMetadata(): Metadata {
  assertServerSurfaceEnabled("publicShares");
  return {
    title: "Your clips",
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
    openGraph: { title: "Your clips" },
  };
}

export default async function GuestPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<React.JSX.Element> {
  assertServerSurfaceEnabled("publicShares");
  const { token } = await params;
  return <GuestPageView token={token} />;
}
