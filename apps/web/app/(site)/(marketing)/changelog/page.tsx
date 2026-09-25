import Link from "next/link";

import { BRAND } from "@montaj/config";
import { PageHeader } from "@montaj/ui";

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
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        title="Changelog"
        description="Every shipped change, in public — starting at launch."
      />

      {CHANGELOG_ENTRIES.length === 0 ? (
        <div
          className="border-border mt-8 flex flex-col items-start gap-2 rounded-md border border-dashed p-6"
          data-testid="changelog-empty"
        >
          <p className="text-fg-0 text-base font-semibold">Nothing published yet</p>
          <p className="text-fg-1 text-sm">
            {BRAND.name} has not launched. Follow along; the first entries land at launch.
          </p>
          <Link href="/status" className="text-accent-300 hover:text-accent-200 mt-1 text-sm">
            See current system status
          </Link>
        </div>
      ) : (
        <ol className="mt-8 flex flex-col" data-testid="changelog-list">
          {CHANGELOG_ENTRIES.map((entry) => (
            <li
              key={entry.id}
              className="border-border grid gap-1 border-b py-8 first:pt-0 last:border-0 sm:grid-cols-[8rem_1fr] sm:gap-6"
            >
              <time dateTime={entry.date} className="text-fg-2 font-mono text-xs sm:pt-1.5">
                {entry.date}
              </time>
              <div>
                <h2 className="text-fg-0 text-lg">{entry.title}</h2>
                <p className="text-fg-1 mt-2 text-sm leading-relaxed">{entry.body}</p>
                {entry.tags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {entry.tags.map((tag) => (
                      <span
                        key={tag}
                        className="bg-bg-2 text-fg-1 rounded-full px-2 py-0.5 text-2xs"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
