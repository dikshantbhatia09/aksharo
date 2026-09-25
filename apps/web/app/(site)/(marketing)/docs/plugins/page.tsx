import Link from "next/link";

import { PageHeader } from "@montaj/ui";

import type { Metadata } from "next";

import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";
import { loadPluginGuides } from "@/lib/docs/plugin-guides";

export function generateMetadata(): Metadata {
  assertServerSurfaceEnabled("plugins");
  return {
    title: "Plugin guides",
    description:
      "Install and use the Aksharo panel inside Premiere Pro, After Effects and DaVinci Resolve.",
    alternates: { canonical: "/docs/plugins" },
  };
}

/** `/docs/plugins`: one guide per host-app plugin, generated from each
 * package's own README (brief §2). See `/plugins` for the marketing/download
 * page — this is the technical install-and-use documentation. */
export default function DocsPluginsPage(): React.JSX.Element {
  assertServerSurfaceEnabled("plugins");
  const guides = loadPluginGuides();

  return (
    <div className="flex flex-col gap-6" data-testid="docs-plugins-index">
      <PageHeader
        title="Plugin guides"
        description={
          <>
            Install and use the Aksharo panel inside your editor. See{" "}
            <Link href="/plugins" className="text-accent-300 hover:text-accent-200">
              /plugins
            </Link>{" "}
            to download.
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {guides.map((guide) => (
          <Link
            key={guide.slug}
            href={`/docs/plugins/${guide.slug}`}
            className="block h-full rounded-md no-underline"
            data-testid={`docs-plugin-${guide.slug}`}
          >
            <div className="border-border bg-surface hover:border-neutral-600 flex h-full flex-col gap-1 rounded-md border p-5 transition-colors">
              <span className="text-fg-0 text-sm font-medium">{guide.title}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
