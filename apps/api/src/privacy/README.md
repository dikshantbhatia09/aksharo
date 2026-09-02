# `privacy/` — A05 + B16

A05 landed `PrivacyController` (the published notice, now also
`GET /privacy/sub-processors`) and `ParentalWaitlistService`. B16 adds:

- **`erasure-cascade.service.ts` + `.task.ts`.** The 30-day cascade
  `DELETE /me` (`ProfileService.requestErasure`, A05) starts: every
  `dsr_requests` row of kind `erasure` still `received` gets its owned
  workspace's media objects deleted (raw then derived, object-first), its
  `provider_submissions` marked `deleteRequestedAt`, its projects deleted
  (Postgres cascades transcripts, EDG documents, comments, share links/
  reports, exports, job events, ...), its remaining workspace-scoped rows
  cleaned up, and the workspace itself **soft**-deleted — never hard-deleted,
  because `invoices.workspace_id` is `onDelete: Cascade` in this schema and a
  hard delete would take 72-month-retained billing documents with it (a seam
  flagged for a future ADR, not changed here). Billing documents are kept
  with `recipientEmail` blanked; `consent_records` and `audit_log` need no
  action — both already point at the anonymised `users` row A05 wrote, which
  **is** the tombstone.
- **`residue-check.service.ts`.** Reads the Prisma DMMF for every model with
  a `userId`/`workspaceId` column and counts what still references a given
  id — the mechanism behind the erasure-sweep contract test
  (`test/erasure-sweep.e2e-spec.ts`) and
  `POST /admin/privacy/erasure/replay-tombstones`
  (`tools/runbooks/privacy-replay-tombstones.js`, for
  `docs/runbooks/breach-first-hour.md`'s "replay the tombstones" step).
- **`breach-incidents.service.ts` + `breach-templates.ts`.**
  `breach_incidents` CRUD and the 72-hour Board-notice clock, with plain
  string (no LLM) Board-report and user-notice drafts — every bracket is
  left for a human to fill in. Behind `admin/privacy/`.
- **`access-log.decorator.ts` + `.interceptor.ts`.** `@LogAccess(resource)`
  writes `access_logs` (not `audit_log`) for a successful read of personal
  data. An interceptor, not a middleware — middleware runs before
  `JwtAuthGuard`, so `request.principal` is not set yet at that point in the
  pipeline.

Admin surfaces (`admin/privacy/`, `admin/scheduler/`) live under `admin/` by
this codebase's own convention (every admin route does, regardless of which
module owns the underlying feature — see `admin/credits/`, `admin/dlq/`),
not under this directory.
