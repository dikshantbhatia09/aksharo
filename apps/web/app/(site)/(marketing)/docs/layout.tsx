import { DocsShell } from "./docs-shell";

import type { ReactNode } from "react";

import { loadHelpArticles } from "@/lib/content/loader";
import { loadDocsSearchIndexSerialised } from "@/lib/docs/content";
import { buildDocsNav } from "@/lib/docs/nav";

/**
 * Shared chrome for every `/docs/**` page: sidebar nav, breadcrumb and
 * search (brief §1). Nav and the search index are both built here, once per
 * request, from the same generators every leaf page reads from (`lib/docs/**`)
 * — there is no second, hand-maintained nav list to fall out of sync.
 */
export default function DocsLayout({ children }: { children: ReactNode }): React.JSX.Element {
  const nav = buildDocsNav(loadHelpArticles());
  const searchIndex = loadDocsSearchIndexSerialised();

  return (
    <DocsShell nav={nav} searchIndex={searchIndex}>
      {children}
    </DocsShell>
  );
}
