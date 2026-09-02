import type { Metadata } from "next";

import { HelpCentre } from "@/components/help/help-centre";
import { loadHelpArticles } from "@/lib/content/loader";
import { buildHelpSearchIndex } from "@/lib/content/search";

export const metadata: Metadata = { title: "Help centre" };

/**
 * `/help` — categories, a client-side search over a build-time MiniSearch
 * index (brief §4), and a "Contact support" entry point.
 */
export default function HelpCentrePage(): React.JSX.Element {
  const articles = loadHelpArticles();
  const searchIndex = buildHelpSearchIndex(articles);
  return <HelpCentre articles={articles} searchIndex={searchIndex} />;
}
