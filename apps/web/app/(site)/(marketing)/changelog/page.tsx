import { BRAND } from "@montaj/config";

import type { Metadata } from "next";

import { CHANGELOG_ENTRIES } from "@/content/site/changelog";

export const metadata: Metadata = {
  title: "Changelog",
  description: `What shipped, and when — ${BRAND.name}'s public changelog.`,
  alternates: { canonical: "/changelog" },
  openGraph: {
    title: `Changelog — ${BRAND.name}`,
    description: "What shipped, and when.",
    url: "/changelog",
    type: "website",
  },
};

export default function ChangelogPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="font-display text-fg-0 text-4xl font-semibold tracking-tight">Changelog</h1>
      <p className="text-fg-1 mt-4 text-lg">
        Every shipped change, in public — starting at launch.
      </p>

      {CHANGELOG_ENTRIES.length === 0 ? (
        <p
          className="border-border text-fg-1 mt-10 rounded-md border border-dashed px-4 py-8 text-center text-sm"
          data-testid="changelog-empty"
        >
          Nothing published yet — {BRAND.name} has not launched. Follow along; the first entries
          land at launch.
        </p>
      ) : (
        <ol className="mt-10 flex flex-col gap-8" data-testid="changelog-list">
          {CHANGELOG_ENTRIES.map((entry) => (
            <li key={entry.id} className="border-border border-b pb-8 last:border-0">
              <time dateTime={entry.date} className="text-fg-2 text-xs">
                {entry.date}
              </time>
              <h2 className="text-fg-0 mt-1 text-lg font-semibold">{entry.title}</h2>
              <p className="text-fg-1 mt-2 text-sm leading-relaxed">{entry.body}</p>
              {entry.tags.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {entry.tags.map((tag) => (
                    <span key={tag} className="bg-bg-2 text-fg-2 rounded-full px-2 py-0.5 text-2xs">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
