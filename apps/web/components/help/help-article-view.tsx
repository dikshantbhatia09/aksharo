import Link from "next/link";

import type { HelpArticle } from "@/lib/content/schema";

import { MarkdownBody } from "@/lib/content/markdown";


/** `/help/{slug}`: one article's content. Server component — no live data. */
export function HelpArticleView({ article }: { readonly article: HelpArticle }): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4" data-testid="help-article">
      <Link href="/help" className="text-fg-2 text-xs hover:underline">
        ← Help centre
      </Link>
      <h1 className="font-display text-fg-0 text-2xl font-semibold tracking-tight">{article.title}</h1>
      <p className="text-fg-1 text-sm">{article.summary}</p>
      <MarkdownBody markdown={article.body} />
    </div>
  );
}
