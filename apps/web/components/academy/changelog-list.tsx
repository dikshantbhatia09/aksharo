import { Card, PageHeader } from "@montaj/ui";

import type { ChangelogEntry } from "@/lib/content/schema";

import { MarkdownBody } from "@/lib/content/markdown";

export function ChangelogList({
  entries,
}: {
  readonly entries: readonly ChangelogEntry[];
}): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <PageHeader title="Changelog" description="What shipped, newest first." />

      {entries.length === 0 ? (
        <p className="text-fg-2 text-sm" data-testid="changelog-empty">
          Nothing published yet. New releases are listed here as they ship.
        </p>
      ) : (
        <ol className="flex flex-col gap-6" data-testid="changelog-entries">
          {entries.map((entry) => (
            <li key={entry.version}>
              <Card className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h2 className="text-fg-0 text-base font-semibold">{entry.title}</h2>
                  <time dateTime={entry.date} className="text-fg-2 text-xs">
                    {entry.date}
                  </time>
                </div>
                <p className="text-fg-2 font-mono text-xs">v{entry.version}</p>
                {entry.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {entry.tags.map((tag) => (
                      <span
                        key={tag}
                        className="border-border text-fg-1 rounded-full border px-2 py-0.5 text-2xs"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <MarkdownBody markdown={entry.body} />
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
