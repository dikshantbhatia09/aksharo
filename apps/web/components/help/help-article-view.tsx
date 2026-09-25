import Link from "next/link";

import { PageHeader } from "@montaj/ui";

import type { HelpArticle } from "@/lib/content/schema";

import { MarkdownBody } from "@/lib/content/markdown";

/** `/help/{slug}`: one article's content. Server component — no live data. */
export function HelpArticleView({ article }: { readonly article: HelpArticle }): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6" data-testid="help-article">
      <div className="flex flex-col gap-4">
        <Link
          href="/help"
          className="text-fg-2 hover:text-fg-0 inline-flex min-h-8 items-center self-start rounded-sm text-sm"
        >
          ← Help centre
        </Link>
        <PageHeader title={article.title} description={article.summary} />
      </div>
      <MarkdownBody markdown={article.body} />
    </div>
  );
}
