import Link from "next/link";

import { PageHeader } from "@montaj/ui";

import type { Metadata } from "next";

import { currentChangelogVersion } from "@/lib/content/loader";
import { API_VERSIONS } from "@/lib/docs/schema";

export const metadata: Metadata = {
  title: "Developers",
  description:
    "The Aksharo public API: authentication, endpoints, webhooks, rate limits, SDK snippets.",
  alternates: { canonical: "/docs/developers" },
};

const SCOPES = [
  { scope: "projects_read", grants: "GET /v1/projects/{id}" },
  { scope: "projects_write", grants: "POST /v1/projects, POST /v1/projects/{id}/transcribe" },
  { scope: "transcripts_read", grants: "GET /v1/projects/{id}/transcript" },
  { scope: "exports_write", grants: "POST /v1/projects/{id}/exports, GET /v1/exports/{id}" },
  { scope: "webhooks_manage", grants: "Webhook endpoint management (via the app, not yet /v1)" },
];

const WEBHOOK_EVENT_ROWS: readonly { event: string; description: string }[] = [
  { event: "transcript.completed", description: "A transcription finished and was persisted." },
  { event: "export.completed", description: "A render/export finished and is ready to download." },
  { event: "job.failed", description: "A job (of any type) reached a terminal failure." },
  {
    event: "credits.low",
    description: "A workspace's credit balance crossed 20% or 0% of its monthly grant.",
  },
];

/**
 * `/docs/developers`: the expanded API reference overview (brief §2: "B14's
 * reference expanded into per-endpoint pages ... webhooks, SDK snippets ...
 * rate limits, SSRF rules, changelog of the API version"). The endpoint
 * table itself moved to `/docs/developers/v1/[group]` (`lib/docs/openapi.ts`);
 * this page keeps everything that doesn't change per-endpoint: auth, scopes,
 * rate limits, idempotency, webhooks, SSRF rules, and errors — the same
 * content `/developers` (B14) rendered, which now redirects here.
 */
export default function DocsDevelopersPage(): React.JSX.Element {
  const productVersion = currentChangelogVersion();

  return (
    <div className="flex flex-col gap-10" data-testid="docs-developers-index">
      <div className="flex flex-col gap-3">
        <PageHeader
          title="Developers"
          description="Create projects, transcribe, export and get notified by webhook — from a script, a CI pipeline or your own product. Available on the Studio and Agency plans."
        />
        <p className="text-fg-2 text-xs" data-testid="docs-developers-changelog">
          API version <code>v1</code>. Product changelog:{" "}
          {productVersion !== null ? (
            <Link href="/changelog" className="text-accent-300 hover:text-accent-200">
              v{productVersion}
            </Link>
          ) : (
            <Link href="/changelog" className="text-accent-300 hover:text-accent-200">
              /changelog
            </Link>
          )}
          .
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-fg-0 text-lg">Versions</h2>
        <div className="flex gap-2">
          {API_VERSIONS.map((version) => (
            <Link
              key={version}
              href={`/docs/developers/${version}`}
              data-testid={`docs-developers-version-${version}`}
              className="border-border text-fg-0 inline-flex h-8 items-center rounded-sm border px-3 font-mono text-sm no-underline hover:bg-neutral-100/7"
            >
              {version}
            </Link>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-fg-0 text-lg">Authentication</h2>
        <p className="text-fg-2 text-sm">
          Every <code>/v1</code> request carries an <code>X-Api-Key</code> header. Mint a key under{" "}
          <strong>Settings → Developers</strong> — the full key is shown once, in the form{" "}
          <code>ak_live_&lt;prefix&gt;.&lt;secret&gt;</code>. A key never has admin or billing
          access; it can only do what its scopes say.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-fg-0 text-lg">Scopes</h2>
        <p className="text-fg-2 text-sm">
          A key carries one or more scopes. There is no <code>admin</code> or <code>billing</code>{" "}
          scope — a key can never reach <code>/admin/*</code>, <code>/billing/*</code> or{" "}
          <code>/me/*</code>, no matter what it is granted.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-border border-b text-left">
                <th scope="col" className="text-fg-2 py-2 pr-4 font-medium">
                  Scope
                </th>
                <th scope="col" className="text-fg-2 py-2 font-medium">
                  Grants
                </th>
              </tr>
            </thead>
            <tbody>
              {SCOPES.map((row) => (
                <tr key={row.scope} className="border-border border-b last:border-0">
                  <td className="text-fg-0 py-2 pr-4 font-mono text-xs">{row.scope}</td>
                  <td className="text-fg-1 py-2">{row.grants}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-fg-0 text-lg">Rate limits</h2>
        <p className="text-fg-2 text-sm">
          60 requests/minute per key, burst to 120 (Agency: 120/min, burst 240). Every response
          carries <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and{" "}
          <code>RateLimit-Reset</code>; a 429 carries <code>Retry-After</code>.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-fg-0 text-lg">Idempotency</h2>
        <p className="text-fg-2 text-sm">
          Pass an <code>Idempotency-Key</code> header on any <code>POST</code>. The same key replays
          the first response for 24 hours; the same key with a different body is refused.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-fg-0 text-lg">sourceUrl imports and SSRF rules</h2>
        <p className="text-fg-2 text-sm">
          <code>POST /v1/projects</code> accepts a <code>sourceUrl</code> instead of an upload. The
          URL is fetched under an SSRF guard: https only, DNS resolved and every address checked
          against private/loopback/link-local/metadata ranges, the connection pinned to the vetted
          address so a later DNS change cannot redirect it, redirects re-validated the same way and
          capped at 3 hops, and a content-type allow-list (video/audio only).
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-fg-0 text-lg">Webhooks</h2>
        <p className="text-fg-2 text-sm">
          Subscribe to any of the events below under{" "}
          <strong>Settings → Developers → Webhooks</strong>. Retries follow 1m, 5m, 30m, 2h, 12h; an
          endpoint that fails 20 deliveries in a row is disabled automatically.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-border border-b">
                <th scope="col" className="text-fg-2 py-2 pr-4 font-medium">
                  Event
                </th>
                <th scope="col" className="text-fg-2 py-2 font-medium">
                  Fires when
                </th>
              </tr>
            </thead>
            <tbody>
              {WEBHOOK_EVENT_ROWS.map((row) => (
                <tr key={row.event} className="border-border border-b last:border-0">
                  <td className="text-fg-0 py-2 pr-4 font-mono text-xs">{row.event}</td>
                  <td className="text-fg-1 py-2">{row.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="text-fg-0 text-base">Verify a webhook</h3>
        <p className="text-fg-2 text-sm">
          Every delivery carries <code>X-Aksharo-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>{" "}
          where <code>v1 = hmac_sha256(secret, t + &quot;.&quot; + body)</code>. Recompute it over
          the *raw* request body — not a re-serialised copy — and compare in constant time.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-fg-0 text-lg">Errors</h2>
        <p className="text-fg-2 text-sm">
          Every error is <code>{"{ code, message, details? }"}</code> with <code>code</code> as{" "}
          <code>namespace/slug</code> (e.g. <code>common/rate_limited</code>,{" "}
          <code>entitlement/upgrade_required</code>). A key missing a scope gets{" "}
          <code>common/forbidden</code> with the required scope in <code>details</code>.
        </p>
      </section>

      <div className="border-border bg-surface rounded-md border p-5">
        <p className="text-fg-1 text-sm">
          Full endpoint reference:{" "}
          <Link href="/docs/developers/v1" className="text-accent-300 hover:text-accent-200">
            /docs/developers/v1
          </Link>
        </p>
      </div>
    </div>
  );
}
