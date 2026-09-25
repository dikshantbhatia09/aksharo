import Link from "next/link";

import openapi from "@montaj/api-client/openapi.json";
import { BRAND } from "@montaj/config";
import { PageHeader } from "@montaj/ui";

import { CodeTabs } from "./code-tabs";
import {
  CURL_CREATE_PROJECT,
  NODE_CREATE_PROJECT,
  PYTHON_CREATE_PROJECT,
} from "./quickstart-snippets";
import {
  CURL_VERIFY_EXAMPLE,
  NODE_VERIFY_SNIPPET,
  PYTHON_VERIFY_SNIPPET,
} from "./signature-snippets";

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

/** No shape change from B14b — these four names have subscribed since B14. */
const WEBHOOK_EVENT_ROWS: readonly { event: string; description: string }[] = [
  { event: "transcript.completed", description: "A transcription finished and was persisted." },
  { event: "export.completed", description: "A render/export finished and is ready to download." },
  { event: "job.failed", description: "A job (of any type) reached a terminal failure." },
  {
    event: "credits.low",
    description: "A workspace's credit balance crossed 20% or 0% of its monthly grant.",
  },
];

function publicEndpoints(): {
  method: string;
  path: string;
  summary: string;
  description?: string;
}[] {
  const doc = openapi as unknown as OpenApiDocument;
  const rows: { method: string; path: string; summary: string; description?: string }[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of METHOD_ORDER) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const op = methods[method];
      if (op === undefined) continue;
      // `public-api/**` controllers are tagged `public` (B14 brief §2); this
      // page IS the OpenAPI document rendered, not a second hand-typed list —
      // add a `/v1` route in the API and it appears here without an edit.
      if (path.startsWith("/v1/")) {
        rows.push({
          method,
          path,
          summary: op.summary ?? op.operationId ?? path,
          description: op.description,
        });
      }
    }
  }
  return rows;
}

const SCOPES = [
  { scope: "projects_read", grants: "GET /v1/projects/{id}" },
  { scope: "projects_write", grants: "POST /v1/projects, POST /v1/projects/{id}/transcribe" },
  { scope: "transcripts_read", grants: "GET /v1/projects/{id}/transcript" },
  { scope: "exports_write", grants: "POST /v1/projects/{id}/exports, GET /v1/exports/{id}" },
  { scope: "webhooks_manage", grants: "Webhook endpoint management (via the app, not yet /v1)" },
];

/**
 * `/developers` (B14 §5): the public API reference.
 *
 * Endpoint table below is read from the real, generated `openapi.json`
 * (`@montaj/api-client/openapi.json`, written by `pnpm gen:client` straight off
 * the API's own Swagger document) rather than hand-copied — the same
 * "generated, not hand-typed" rule `packages/api-client` follows for the
 * client itself. **Deviation from the brief**, flagged in the WP's final
 * report: this is a small custom renderer over that document rather than
 * Scalar or Redoc bundled locally. Neither is vendored in this repo yet, and
 * the "no CDN" constraint means adding one is a real dependency-and-bundle-size
 * decision (Scalar's package alone is several hundred KB), not a drop-in — left
 * for a follow-up rather than done half-carefully here. Everything the brief
 * asks the page to contain (endpoints, auth, quick-starts in curl/Node/Python)
 * is present; only the rendering engine differs from the suggestion.
 */
export function DevelopersDocs(): React.JSX.Element {
  const endpoints = publicEndpoints();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-10 sm:px-6 sm:py-14">
      <Link
        href="/"
        aria-label={`${BRAND.name} home`}
        className="font-display text-fg-0 inline-flex min-h-8 items-center self-start rounded-sm text-lg font-semibold tracking-tight no-underline"
      >
        {BRAND.name}
      </Link>

      <PageHeader
        eyebrow="Developers"
        title={`${BRAND.name} API`}
        description="Create projects, transcribe, export and get notified by webhook — from a script, a CI pipeline or your own product. Available on the Studio and Agency plans."
      />

      <nav aria-label="On this page" className="border-border bg-surface rounded-md border p-5">
        <h2 className="text-fg-2 mb-2 text-xs font-medium">On this page</h2>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="text-fg-1 hover:text-fg-0 inline-flex min-h-8 items-center rounded-sm no-underline hover:underline"
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <DocSection id="authentication" title="Authentication">
        <p className="text-fg-1 text-sm">
          Every <code>/v1</code> request carries an <code>X-Api-Key</code> header. Mint a key under{" "}
          <strong className="text-fg-0">Settings → Developers</strong> — the full key is shown once,
          in the form <code>ak_live_&lt;prefix&gt;.&lt;secret&gt;</code>. A key never has admin or
          billing access; it can only do what its scopes say.
        </p>
        <CodeTabs
          label="Create a project"
          tabs={[
            { label: "curl", language: "bash", code: CURL_CREATE_PROJECT },
            { label: "Node", language: "javascript", code: NODE_CREATE_PROJECT },
            { label: "Python", language: "python", code: PYTHON_CREATE_PROJECT },
          ]}
        />
      </DocSection>

      <DocSection id="scopes" title="Scopes">
        <p className="text-fg-1 text-sm">
          A key carries one or more scopes. There is no <code>admin</code> or <code>billing</code>{" "}
          scope — a key can never reach <code>/admin/*</code>, <code>/billing/*</code> or{" "}
          <code>/me/*</code>, no matter what it is granted.
        </p>
        <DocTable
          caption="API key scopes and the endpoints each one grants"
          columns={["Scope", "Grants"]}
          rows={SCOPES.map((row) => ({ key: row.scope, cells: [row.scope, row.grants] }))}
          monoColumns={[0]}
        />
      </DocSection>

      <DocSection id="rate-limits" title="Rate limits">
        <p className="text-fg-1 text-sm">
          60 requests/minute per key, burst to 120 (Agency: 120/min, burst 240). Every response
          carries <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and{" "}
          <code>RateLimit-Reset</code>; a 429 carries <code>Retry-After</code>.
        </p>
      </DocSection>

      <DocSection id="idempotency" title="Idempotency">
        <p className="text-fg-1 text-sm">
          Pass an <code>Idempotency-Key</code> header on any <code>POST</code>. The same key replays
          the first response for 24 hours; the same key with a different body is refused.
        </p>
      </DocSection>

      <DocSection id="endpoints" title="Endpoints">
        {endpoints.length === 0 ? (
          <p className="text-fg-2 text-sm">
            No public endpoints are published in this build&apos;s API document.
          </p>
        ) : (
          <DocTable
            caption="Public /v1 endpoints"
            columns={["Method", "Path", "Summary"]}
            rows={endpoints.map((row) => ({
              key: `${row.method}-${row.path}`,
              cells: [row.method.toUpperCase(), row.path, row.summary],
            }))}
            monoColumns={[0, 1]}
          />
        )}
      </DocSection>

      <DocSection id="source-url" title="sourceUrl imports">
        <p className="text-fg-1 text-sm">
          <code>POST /v1/projects</code> accepts a <code>sourceUrl</code> instead of an upload. The
          URL is fetched under an SSRF guard: https only, DNS resolved and every address checked
          against private/loopback/link-local/metadata ranges, the connection pinned to the vetted
          address so a later DNS change cannot redirect it, redirects re-validated the same way and
          capped at 3 hops, and a content-type allow-list (video/audio only).
        </p>
      </DocSection>

      <DocSection id="webhooks" title="Webhooks">
        <p className="text-fg-1 text-sm">
          Subscribe to any of the events below under{" "}
          <strong className="text-fg-0">Settings → Developers → Webhooks</strong>. Retries follow
          1m, 5m, 30m, 2h, 12h; an endpoint that fails 20 deliveries in a row is disabled
          automatically.
        </p>
        <DocTable
          caption="Webhook events"
          columns={["Event", "Fires when"]}
          rows={WEBHOOK_EVENT_ROWS.map((row) => ({
            key: row.event,
            cells: [row.event, row.description],
          }))}
          monoColumns={[0]}
        />
        <h3 className="text-fg-0 mt-2 text-base font-semibold">Verify a webhook</h3>
        <p className="text-fg-1 text-sm">
          Every delivery carries <code>X-Aksharo-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>{" "}
          where <code>v1 = hmac_sha256(secret, t + &quot;.&quot; + body)</code>. Recompute it over
          the <em>raw</em> request body — not a re-serialised copy — and compare in constant time.
        </p>
        <CodeTabs
          label="Verify a webhook signature"
          tabs={[
            { label: "curl", language: "bash", code: CURL_VERIFY_EXAMPLE },
            { label: "Node", language: "javascript", code: NODE_VERIFY_SNIPPET },
            { label: "Python", language: "python", code: PYTHON_VERIFY_SNIPPET },
          ]}
        />
      </DocSection>

      <DocSection id="errors" title="Errors">
        <p className="text-fg-1 text-sm">
          Every error is <code>{"{ code, message, details? }"}</code> with <code>code</code> as{" "}
          <code>namespace/slug</code> (e.g. <code>common/rate_limited</code>,{" "}
          <code>entitlement/upgrade_required</code>). A key missing a scope gets{" "}
          <code>common/forbidden</code> with the required scope in <code>details</code>.
        </p>
      </DocSection>
    </main>
  );
}

const SECTIONS: readonly { id: string; label: string }[] = [
  { id: "authentication", label: "Authentication" },
  { id: "scopes", label: "Scopes" },
  { id: "rate-limits", label: "Rate limits" },
  { id: "idempotency", label: "Idempotency" },
  { id: "endpoints", label: "Endpoints" },
  { id: "source-url", label: "sourceUrl imports" },
  { id: "webhooks", label: "Webhooks" },
  { id: "errors", label: "Errors" },
];

/** One reference section: an anchored `h2` (Inter, not the display face) and its body. */
function DocSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex scroll-mt-6 flex-col gap-4">
      <h2 id={`${id}-heading`} className="text-fg-0 text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A reference table: hairline rows, column headers scoped, horizontal scroll on narrow screens. */
function DocTable({
  caption,
  columns,
  rows,
  monoColumns = [],
}: {
  caption: string;
  columns: readonly string[];
  rows: readonly { key: string; cells: readonly string[] }[];
  monoColumns?: readonly number[];
}): React.JSX.Element {
  return (
    <div
      className="border-border overflow-x-auto rounded-md border"
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-sunken">
          <tr className="border-border border-b">
            {columns.map((column) => (
              <th key={column} scope="col" className="text-fg-2 px-4 py-2 text-xs font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, index) => (
                <td
                  key={index}
                  className={
                    monoColumns.includes(index)
                      ? "text-fg-0 px-4 py-2 font-mono text-xs whitespace-nowrap"
                      : "text-fg-1 px-4 py-2"
                  }
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
