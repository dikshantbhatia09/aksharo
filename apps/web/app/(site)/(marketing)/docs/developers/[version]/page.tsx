import Link from "next/link";
import { notFound } from "next/navigation";

import { Card } from "@montaj/ui";

import type { Metadata } from "next";

import { loadApiGroups } from "@/lib/docs/openapi";
import { API_VERSIONS, type ApiVersion } from "@/lib/docs/schema";

export function generateStaticParams(): { version: string }[] {
  return API_VERSIONS.map((version) => ({ version }));
}

export function generateMetadata({ params }: { params: { version: string } }): Metadata {
  if (!isApiVersion(params.version)) return {};
  return {
    title: `API reference — ${params.version}`,
    description: `Aksharo public API endpoints, grouped by resource — ${params.version}.`,
    alternates: { canonical: `/docs/developers/${params.version}` },
  };
}

function isApiVersion(value: string): value is ApiVersion {
  return (API_VERSIONS as readonly string[]).includes(value);
}

/** `/docs/developers/v1`: the version index — one card per resource group,
 * generated straight off `openapi.json` (brief §2). */
export default function DocsApiVersionPage({
  params,
}: {
  params: { version: string };
}): React.JSX.Element {
  if (!isApiVersion(params.version)) notFound();
  const groups = loadApiGroups();

  return (
    <div className="flex flex-col gap-6" data-testid="docs-developers-version">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-fg-0 text-2xl font-semibold tracking-tight">
          API reference — {params.version}
        </h1>
        <p className="text-fg-2 text-sm">Endpoints, grouped by resource.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {groups.map((group) => (
          <Link
            key={group.tag}
            href={`/docs/developers/${params.version}/${group.tag}`}
            data-testid={`docs-api-group-${group.tag}`}
          >
            <Card className="flex h-full flex-col gap-1 p-4 transition hover:shadow-sm">
              <p className="text-fg-0 text-sm font-medium">{group.label}</p>
              <p className="text-fg-2 text-xs">
                {group.endpoints.length} endpoint{group.endpoints.length === 1 ? "" : "s"}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
