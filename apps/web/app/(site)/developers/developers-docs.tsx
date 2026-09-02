import openapi from "@montaj/api-client/openapi.json";

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
    <div className="mx-auto flex max-w-3xl flex-col gap-12 px-4 py-16">
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Aksharo API</h1>
        <p className="text-fg-2 text-base">
          Create projects, transcribe, export and get notified by webhook — from a script, a CI
          pipeline or your own product. Available on the Studio and Agency plans.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Authentication</h2>
        <p className="text-fg-2 text-sm">
          Every <code>/v1</code> request carries an <code>X-Api-Key</code> header. Mint a key under{" "}
          <strong>Settings → Developers</strong> — the full key is shown once, in the form{" "}
          <code>ak_live_&lt;prefix&gt;.&lt;secret&gt;</code>. A key never has admin or billing
          access; it can only do what its scopes say.
        </p>
        <CodeTabs
          tabs={[
            { label: "curl", language: "bash", code: CURL_CREATE_PROJECT },
            { label: "Node", language: "javascript", code: NODE_CREATE_PROJECT },
            { label: "Python", language: "python", code: PYTHON_CREATE_PROJECT },
          ]}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Scopes</h2>
        <p className="text-fg-2 text-sm">
          A key carries one or more scopes. There is no <code>admin</code> or <code>billing</code>{" "}
          scope — a key can never reach <code>/admin/*</code>, <code>/billing/*</code> or{" "}
          <code>/me/*</code>, no matter what it is granted.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-border border-b text-left">
                <th className="py-2 pr-4 font-medium">Scope</th>
                <th className="py-2 font-medium">Grants</th>
              </tr>
            </thead>
            <tbody>
              {SCOPES.map((row) => (
                <tr key={row.scope} className="border-border/50 border-b">
                  <td className="py-2 pr-4 font-mono text-xs">{row.scope}</td>
                  <td className="text-fg-1 py-2">{row.grants}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Rate limits</h2>
        <p className="text-fg-2 text-sm">
          60 requests/minute per key, burst to 120 (Agency: 120/min, burst 240). Every response
          carries <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and{" "}
          <code>RateLimit-Reset</code>; a 429 carries <code>Retry-After</code>.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Idempotency</h2>
        <p className="text-fg-2 text-sm">
          Pass an <code>Idempotency-Key</code> header on any <code>POST</code>. The same key replays
          the first response for 24 hours; the same key with a different body is refused.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Endpoints</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-border border-b text-left">
                <th className="py-2 pr-4 font-medium">Method</th>
                <th className="py-2 pr-4 font-medium">Path</th>
                <th className="py-2 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((row) => (
                <tr key={`${row.method}-${row.path}`} className="border-border/50 border-b">
                  <td className="py-2 pr-4 font-mono text-xs uppercase">{row.method}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{row.path}</td>
                  <td className="text-fg-1 py-2">{row.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">sourceUrl imports</h2>
        <p className="text-fg-2 text-sm">
          <code>POST /v1/projects</code> accepts a <code>sourceUrl</code> instead of an upload. The
          URL is fetched under an SSRF guard: https only, DNS resolved and every address checked
          against private/loopback/link-local/metadata ranges, the connection pinned to the vetted
          address so a later DNS change cannot redirect it, redirects re-validated the same way and
          capped at 3 hops, and a content-type allow-list (video/audio only).
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Webhooks</h2>
        <p className="text-fg-2 text-sm">
          Subscribe to any of the events below under{" "}
          <strong>Settings → Developers → Webhooks</strong>. Retries follow 1m, 5m, 30m, 2h, 12h; an
          endpoint that fails 20 deliveries in a row is disabled automatically.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-border border-b">
                <th className="py-2 pr-4 font-medium">Event</th>
                <th className="py-2 font-medium">Fires when</th>
              </tr>
            </thead>
            <tbody>
              {WEBHOOK_EVENT_ROWS.map((row) => (
                <tr key={row.event} className="border-border/50 border-b">
                  <td className="py-2 pr-4 font-mono text-xs">{row.event}</td>
                  <td className="text-fg-1 py-2">{row.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="text-base font-semibold">Verify a webhook</h3>
        <p className="text-fg-2 text-sm">
          Every delivery carries <code>X-Aksharo-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>{" "}
          where <code>v1 = hmac_sha256(secret, t + &quot;.&quot; + body)</code>. Recompute it over
          the *raw* request body — not a re-serialised copy — and compare in constant time.
        </p>
        <CodeTabs
          tabs={[
            { label: "curl", language: "bash", code: CURL_VERIFY_EXAMPLE },
            { label: "Node", language: "javascript", code: NODE_VERIFY_SNIPPET },
            { label: "Python", language: "python", code: PYTHON_VERIFY_SNIPPET },
          ]}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Errors</h2>
        <p className="text-fg-2 text-sm">
          Every error is <code>{"{ code, message, details? }"}</code> with <code>code</code> as{" "}
          <code>namespace/slug</code> (e.g. <code>common/rate_limited</code>,{" "}
          <code>entitlement/upgrade_required</code>). A key missing a scope gets{" "}
          <code>common/forbidden</code> with the required scope in <code>details</code>.
        </p>
      </section>
    </div>
  );
}
