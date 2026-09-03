import Link from "next/link";

import { Card } from "@montaj/ui";

import type { Metadata } from "next";

import { DOCS_SECTIONS } from "@/content/docs/overview";

export const metadata: Metadata = {
  title: "Docs",
  description: "Guides, plugin guides, the developer API reference and legal — one docs site.",
  alternates: { canonical: "/docs" },
};

export default function DocsIndexPage(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6" data-testid="docs-index">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-fg-0 text-3xl font-semibold tracking-tight">Docs</h1>
        <p className="text-fg-2 text-sm">
          Everything about using Aksharo: creator guides, plugin guides, the developer API, and
          legal.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {DOCS_SECTIONS.map((section) => (
          <Link key={section.id} href={section.href} data-testid={`docs-section-${section.id}`}>
            <Card className="flex h-full flex-col gap-2 p-5 transition hover:shadow-sm">
              <h2 className="text-fg-0 text-lg font-semibold">{section.title}</h2>
              <p className="text-fg-2 text-sm">{section.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
