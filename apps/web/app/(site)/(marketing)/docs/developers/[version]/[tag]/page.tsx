import { notFound } from "next/navigation";

import { PageHeader } from "@montaj/ui";

import { EditThisPage } from "../../../edit-this-page";

import type { Metadata } from "next";

import { CodeTabs } from "@/app/(site)/developers/code-tabs";
import { findApiGroup, loadApiGroups, snippetsFor } from "@/lib/docs/openapi";
import { API_VERSIONS, type ApiEndpoint, type ApiVersion } from "@/lib/docs/schema";

function isApiVersion(value: string): value is ApiVersion {
  return (API_VERSIONS as readonly string[]).includes(value);
}

export function generateStaticParams(): { version: string; tag: string }[] {
  return API_VERSIONS.flatMap((version) =>
    loadApiGroups().map((group) => ({ version, tag: group.tag })),
  );
}

export async function generateMetadata({
  params: pendingParams,
}: {
  params: Promise<{ version: string; tag: string }>;
}): Promise<Metadata> {
  const params = await pendingParams;
  const group = findApiGroup(params.tag);
  if (!group) return {};
  return {
    title: `${group.label} — API reference`,
    description: `${group.label} endpoints — Aksharo public API ${params.version}.`,
    alternates: { canonical: `/docs/developers/${params.version}/${params.tag}` },
  };
}

function EndpointSection({ endpoint }: { readonly endpoint: ApiEndpoint }): React.JSX.Element {
  const snippets = snippetsFor(endpoint);
  return (
    <section
      className="border-border flex flex-col gap-4 border-b pb-8 last:border-b-0"
      data-testid={`docs-endpoint-${endpoint.operationId}`}
    >
      <header className="flex flex-col gap-1">
        <p className="font-mono text-sm">
          <span className="bg-bg-2 text-fg-0 rounded-sm px-1.5 py-0.5 text-xs font-semibold uppercase">
            {endpoint.method}
          </span>{" "}
          <span className="text-fg-0">{endpoint.path}</span>
        </p>
        <h2 className="text-fg-0 text-lg">{endpoint.summary}</h2>
        {endpoint.description ? <p className="text-fg-2 text-sm">{endpoint.description}</p> : null}
      </header>

      {endpoint.parameters.length > 0 ? (
        <div>
          <h3 className="text-fg-0 mb-2 text-sm font-semibold">Parameters</h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-border border-b text-left">
                  <th scope="col" className="text-fg-2 py-1.5 pr-4 font-medium">
                    Name
                  </th>
                  <th scope="col" className="text-fg-2 py-1.5 pr-4 font-medium">
                    In
                  </th>
                  <th scope="col" className="text-fg-2 py-1.5 pr-4 font-medium">
                    Type
                  </th>
                  <th scope="col" className="text-fg-2 py-1.5 font-medium">
                    Required
                  </th>
                </tr>
              </thead>
              <tbody>
                {endpoint.parameters.map((parameter) => (
                  <tr key={parameter.name} className="border-border border-b last:border-0">
                    <td className="text-fg-0 py-1.5 pr-4 font-mono text-xs">{parameter.name}</td>
                    <td className="text-fg-1 py-1.5 pr-4">{parameter.in}</td>
                    <td className="text-fg-1 py-1.5 pr-4 font-mono text-xs">{parameter.type}</td>
                    <td className="text-fg-1 py-1.5">{parameter.required ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div>
        <h3 className="text-fg-0 mb-2 text-sm font-semibold">Responses</h3>
        <p className="text-fg-2 text-xs font-mono">{endpoint.responseStatuses.join(", ")}</p>
      </div>

      <div>
        <h3 className="text-fg-0 mb-2 text-sm font-semibold">Example</h3>
        <CodeTabs
          tabs={[
            { label: "curl", language: "bash", code: snippets.curl },
            { label: "Node", language: "javascript", code: snippets.node },
            { label: "Python", language: "python", code: snippets.python },
          ]}
        />
      </div>
    </section>
  );
}

/** `/docs/developers/v1/[tag]`: one page per resource group, every endpoint
 * generated from `openapi.json` at build time (brief §2) — parameters,
 * responses and curl/Node/Python examples included, so a new `/v1` route
 * appears here without a hand-edit. */
export default async function DocsApiGroupPage({
  params: pendingParams,
}: {
  params: Promise<{ version: string; tag: string }>;
}): Promise<React.JSX.Element> {
  const params = await pendingParams;
  if (!isApiVersion(params.version)) notFound();
  const group = findApiGroup(params.tag);
  if (!group) notFound();

  return (
    <div className="flex flex-col gap-6" data-testid="docs-api-group-page">
      <PageHeader
        title={group.label}
        actions={<EditThisPage repoPath="packages/api-client/openapi.json" />}
      />
      <div className="flex flex-col gap-8">
        {group.endpoints.map((endpoint) => (
          <EndpointSection key={endpoint.operationId} endpoint={endpoint} />
        ))}
      </div>
    </div>
  );
}
