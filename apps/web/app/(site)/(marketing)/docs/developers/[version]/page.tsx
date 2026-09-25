import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@montaj/ui";

import type { Metadata } from "next";

import { loadApiGroups } from "@/lib/docs/openapi";
import { API_VERSIONS, type ApiVersion } from "@/lib/docs/schema";

export function generateStaticParams(): { version: string }[] {
  return API_VERSIONS.map((version) => ({ version }));
}

export async function generateMetadata({
  params: pendingParams,
}: {
  params: Promise<{ version: string }>;
}): Promise<Metadata> {
  const params = await pendingParams;
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
export default async function DocsApiVersionPage({
  params: pendingParams,
}: {
  params: Promise<{ version: string }>;
}): Promise<React.JSX.Element> {
  const params = await pendingParams;
  if (!isApiVersion(params.version)) notFound();
  const groups = loadApiGroups();

  return (
    <div className="flex flex-col gap-6" data-testid="docs-developers-version">
      <PageHeader
        title={<>API reference — {params.version}</>}
        description="Endpoints, grouped by resource."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {groups.map((group) => (
          <Link
            key={group.tag}
            href={`/docs/developers/${params.version}/${group.tag}`}
            className="block h-full rounded-md no-underline"
            data-testid={`docs-api-group-${group.tag}`}
          >
            <div className="border-border bg-surface hover:border-neutral-600 flex h-full flex-col gap-1 rounded-md border p-5 transition-colors">
              <span className="text-fg-0 text-sm font-medium">{group.label}</span>
              <span className="text-fg-2 text-xs">
                {group.endpoints.length} endpoint{group.endpoints.length === 1 ? "" : "s"}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
