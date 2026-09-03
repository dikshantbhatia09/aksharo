import Link from "next/link";

import { Card } from "@montaj/ui";

import type { Metadata } from "next";

import { loadPluginGuides } from "@/lib/docs/plugin-guides";

export const metadata: Metadata = {
  title: "Plugin guides",
  description:
    "Install and use the Aksharo panel inside Premiere Pro, After Effects and DaVinci Resolve.",
  alternates: { canonical: "/docs/plugins" },
};

/** `/docs/plugins`: one guide per host-app plugin, generated from each
 * package's own README (brief §2). See `/plugins` for the marketing/download
 * page — this is the technical install-and-use documentation. */
export default function DocsPluginsPage(): React.JSX.Element {
  const guides = loadPluginGuides();

  return (
    <div className="flex flex-col gap-6" data-testid="docs-plugins-index">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-fg-0 text-2xl font-semibold tracking-tight">
          Plugin guides
        </h1>
        <p className="text-fg-2 text-sm">
          Install and use the Aksharo panel inside your editor. See{" "}
          <Link href="/plugins" className="text-accent underline">
            /plugins
          </Link>{" "}
          to download.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {guides.map((guide) => (
          <Link
            key={guide.slug}
            href={`/docs/plugins/${guide.slug}`}
            data-testid={`docs-plugin-${guide.slug}`}
          >
            <Card className="flex h-full flex-col gap-1 p-4 transition hover:shadow-sm">
              <p className="text-fg-0 text-sm font-medium">{guide.title}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
