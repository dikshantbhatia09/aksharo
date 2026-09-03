import openapi from "@montaj/api-client/openapi.json";

import type { ApiEndpoint, ApiGroup, ApiParameter } from "./schema";

interface OpenApiParameter {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly schema?: { readonly type?: string };
}

interface OpenApiOperation {
  readonly tags?: readonly string[];
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: unknown;
  readonly responses?: Record<string, unknown>;
}

interface OpenApiDocument {
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
}

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"] as const;

const GROUP_LABELS: Record<string, string> = {
  projects: "Projects",
  exports: "Exports",
  jobs: "Jobs",
};

function labelFor(tag: string): string {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a path segment parsed from this repo's own generated openapi.json, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return GROUP_LABELS[tag] ?? `${tag.charAt(0).toUpperCase()}${tag.slice(1)}`;
}

/**
 * The first path segment after `/v1/` (e.g. `/v1/projects/{id}` -> `projects`).
 * `docs/CONTRACTS.md`'s public API is small (7 endpoints as of this WP) and
 * every one of them is tagged `public` in the OpenAPI document — grouping by
 * that OpenAPI `tag` the way B14's original renderer implied would put all 7
 * endpoints in a single "Public" group, which is not a useful nav. Grouping
 * by the resource in the path itself is what B14's own endpoint table already
 * reads as (Projects / Exports / Jobs), so this generator does the same,
 * deterministically, off the path string rather than a second hand-maintained
 * list.
 */
function groupTagFor(path: string): string {
  const match = /^\/v1\/([a-z-]+)/.exec(path);
  return match?.[1] ?? "misc";
}

function toParameter(parameter: OpenApiParameter): ApiParameter {
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required ?? false,
    type: parameter.schema?.type ?? "string",
  };
}

// M07: this used to re-walk and re-sort the whole 298-operation OpenAPI
// document (`packages/api-client/openapi.json`, ~760KB parsed) on every call.
// `/docs/developers/**` static generation calls `loadApiGroups()` from
// `generateStaticParams`, `generateMetadata` *and* the page component for
// every version/tag combination, and `DocsLayout` (every `/docs/**` page,
// transitively via `loadDocsSearchDocs`) called it again — dozens of full
// re-derivations per build across ~117 static pages. The document is fixed
// per process (it is not touched by this WP), so the derived groups are
// memoised once per worker instead of rebuilt per page; this is the fix the
// M07 brief calls for, not a heap-size workaround.
let groupsCache: readonly ApiGroup[] | undefined;

/** Parses `@montaj/api-client/openapi.json`'s `/v1/*` paths into per-resource
 * groups, at build time — this IS the generated OpenAPI document rendered,
 * never a second hand-typed endpoint list (same rule B14's original page
 * followed). Memoised per process (see comment above); the result is
 * read-only data derived from a document that is static within a build. */
export function loadApiGroups(): readonly ApiGroup[] {
  if (groupsCache) return groupsCache;

  const doc = openapi as unknown as OpenApiDocument;
  const groups = new Map<string, ApiEndpoint[]>();

  for (const [path, methods] of Object.entries(doc.paths)) {
    if (!path.startsWith("/v1/")) continue;
    const tag = groupTagFor(path);
    for (const method of METHOD_ORDER) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on `method`, a fixed literal from METHOD_ORDER, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      const op = methods[method];
      if (op === undefined) continue;
      const endpoint: ApiEndpoint = {
        method,
        path,
        operationId: op.operationId ?? `${method}-${path}`,
        summary: op.summary ?? op.operationId ?? path,
        description: op.description,
        parameters: (op.parameters ?? []).map(toParameter),
        hasRequestBody: op.requestBody !== undefined,
        responseStatuses: Object.keys(op.responses ?? {}),
      };
      const list = groups.get(tag) ?? [];
      list.push(endpoint);
      groups.set(tag, list);
    }
  }

  groupsCache = Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, endpoints]) => ({
      tag,
      label: labelFor(tag),
      endpoints: endpoints.sort(
        (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
      ),
    }));
  return groupsCache;
}

export function findApiGroup(tag: string): ApiGroup | undefined {
  return loadApiGroups().find((group) => group.tag === tag);
}

function pathToPlaceholderUrl(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => `<${name}>`);
}

/** curl/Node/Python quick-start for one endpoint (brief: "SDK snippets in
 * curl/Node/Python"), templated off the endpoint shape rather than hand-typed
 * per route so a new `/v1` route gets working snippets for free. */
export function snippetsFor(endpoint: ApiEndpoint): {
  readonly curl: string;
  readonly node: string;
  readonly python: string;
} {
  const url = `https://api.aksharo.com${pathToPlaceholderUrl(endpoint.path)}`;
  const method = endpoint.method.toUpperCase();
  const body = endpoint.hasRequestBody ? ` \\\n  -d '{}'` : "";

  const curl = [
    `curl -X ${method} "${url}" \\`,
    `  -H "X-Api-Key: $AKSHARO_API_KEY" \\`,
    `  -H "Content-Type: application/json"${body}`,
  ].join("\n");

  const node = [
    `const response = await fetch("${url}", {`,
    `  method: "${method}",`,
    `  headers: {`,
    `    "X-Api-Key": process.env.AKSHARO_API_KEY,`,
    `    "Content-Type": "application/json",`,
    `  },`,
    endpoint.hasRequestBody ? `  body: JSON.stringify({}),` : undefined,
    `});`,
    `const data = await response.json();`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  const python = [
    `import os, requests`,
    ``,
    `response = requests.${endpoint.method}(`,
    `    "${url}",`,
    `    headers={"X-Api-Key": os.environ["AKSHARO_API_KEY"]},`,
    endpoint.hasRequestBody ? `    json={},` : undefined,
    `)`,
    `data = response.json()`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  return { curl, node, python };
}
