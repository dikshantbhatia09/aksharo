import type { Metadata } from "next";

import { ChangelogList } from "@/components/academy/changelog-list";
import { loadChangelogEntries } from "@/lib/content/loader";


export const metadata: Metadata = { title: "Changelog" };

/**
 * `/updates` (signed-in app's in-app changelog). Named `/updates` rather than
 * `/changelog` because the marketing site (A24, out of scope here) already
 * owns `/changelog` — Next.js refuses two route groups resolving the same
 * path, so this had to move; the What's-new modal's "See full changelog"
 * link and `lib/nav.ts` point here. What shipped, MDX-sourced, newest first.
 */
export default function InAppChangelogPage(): React.JSX.Element {
  const entries = loadChangelogEntries();
  return <ChangelogList entries={entries} />;
}
