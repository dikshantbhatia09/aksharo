import Link from "next/link";

import { PageHeader } from "@montaj/ui";

import type { Metadata } from "next";

import { DOCS_SECTIONS } from "@/content/docs/overview";

export const metadata: Metadata = {
  title: "Docs",
  description: "Guides, plugin guides, the developer API reference and legal — one docs site.",
  alternates: { canonical: "/docs" },
};

export default function DocsIndexPage(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8" data-testid="docs-index">
      <PageHeader
        title="Docs"
        description="Everything about using Aksharo: creator guides, plugin guides, the developer API, and legal."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {DOCS_SECTIONS.map((section) => (
          <Link
            key={section.id}
            href={section.href}
            className="block h-full rounded-md no-underline"
            data-testid={`docs-section-${section.id}`}
          >
            <div className="border-border bg-surface hover:border-neutral-600 flex h-full flex-col gap-2 rounded-md border p-5 transition-colors">
              <h2 className="text-fg-0 text-lg">{section.title}</h2>
              <p className="text-fg-2 text-sm">{section.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
