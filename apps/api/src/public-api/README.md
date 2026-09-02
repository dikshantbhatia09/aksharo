# public-api

The customer-facing API: key issuance (`keys/`) and the `/v1` surface
(`v1/`).

## Key issuance (`keys/`)

`ApiKeysController` (`/workspaces/{id}/api-keys`, JWT session, `admin` role)
mints, rotates and revokes keys. A key is `ak_live_<prefix>.<secret>` — the
shape `common/guards/api-key.guard.ts` (A04) expects, unchanged here except
that the guard now also refuses a key past `expiresAt`, which is how rotation
gives the old key a 24h overlap window instead of revoking it outright.
Minting requires the `apiAccess` entitlement (Studio/Agency).

Scopes are a closed Prisma enum (`ApiKeyScope`): `projects_read`,
`projects_write`, `transcripts_read`, `exports_write`, `webhooks_manage`.
There is no `admin` or `billing` scope — the enum itself is the guarantee.
`ApiKeyGuard` derives the principal's role from the scopes: any write scope
caps it at `editor`, never higher.

## `/v1` (`v1/`)

Every route wears `ApiKeyGuard` + `ApiKeyRateLimitGuard` and requires
`X-Api-Key`. `RateLimit-*` response headers (not `X-RateLimit-*` — a
deliberate difference from the web app's own routes, see
`api-key-rate-limit.guard.ts`'s doc comment). Every mutating route is wrapped
in `withIdempotency()` (`idempotency.service.ts`): a caller that retries a
`POST` with the same `Idempotency-Key` gets the first response back rather
than a second project/export/transcription. Records expire after 24h.

Endpoints: `POST|GET /v1/projects`, `POST /v1/projects/{id}/transcribe`,
`GET /v1/projects/{id}/transcript?format=json|srt|vtt`, `POST
/v1/projects/{id}/exports` (always the cloud render path — a signed browser
manifest is meaningless to a script), `GET /v1/exports/{id}`, `GET
/v1/jobs/{id}`. Every one of these wraps an existing service
(`ProjectsService`, `TranscriptsService`, `ExportsService`, `JobsService`) —
nothing here reimplements their business logic.

`sourceUrl` project creation (`v1/source-url-ingest.service.ts`) is the one
new piece of ingest logic: `MediaService` (A06) has no public method for
"ingest a buffer this process already downloaded" (its surface is built for a
browser's presigned multipart upload), so this reuses the same low-level
primitives `MediaService.attachSample()` does (`RAW_STORE`, `rawKey`,
`JobsService.enqueue("media.probe")`) rather than adding to a file outside
this WP's boundaries. The download itself goes through `common/net/safe-fetch.ts`
(A06's SSRF guard) unchanged.
