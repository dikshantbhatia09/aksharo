# `support` — support tickets with diagnostics (B12)

`POST /support/tickets` and `GET /support/tickets`: a workspace member's own
support requests, optionally carrying a consent-gated diagnostics bundle,
emailed to `BRAND.supportEmail` via `notify`.

## What this module owns

- `SupportService.createTicket` — writes a `support_tickets` row, then
  best-effort emails `BRAND.supportEmail` (kind `"support-ticket-created"`,
  added to `notify.kinds.ts`). The email is a side effect: a `NotifyService`
  failure is logged and swallowed, never turned into a failed ticket creation
  (`NotifyService.enqueue`'s own contract — it only throws for a caller bug).
- `SupportService.listTickets` — this workspace's own tickets, newest first.
- `support.dto.ts`'s `SupportDiagnosticsSchema` — the server-side shape and
  size caps for the diagnostics bundle (10 jobs, 20 console-error lines, no
  media, no free-form nesting) the client assembles and the caller opts into.

## Diagnostics: what's in the bundle, and what never is

Assembled entirely client-side
(`apps/web/components/support/support-view.tsx` +
`apps/web/components/support/diagnostics.ts`), only when the requester checks
the consent box:

- app version, browser/OS (a coarse user-agent parse, not a fingerprint)
- workspace id
- the last 10 job ids and statuses (`GET /jobs?limit=10`, workspace-scoped)
- a client-side console-error ring buffer (`console.error` calls only, capped
  at 20, 500 chars each)

**Never included:** media, transcript content, or anything from the EDG
document. The server-side schema enforces the same caps as a second line of
defence against a client that sends more than the UI offers.

## Conflict/deviation flagged for the orchestrator

- **File boundary.** The brief's boundary lists
  `apps/web/app/(app)/{academy,help,changelog}/**`, but brief §5 requires
  tickets "listed in Settings → Support" — there is no such surface without a
  route under `apps/web/app/(app)/settings/support/**` and a
  `apps/web/lib/nav.ts` entry. Both are one-line/one-entry additions; all real
  logic stays in `apps/web/components/support/**`, inside the declared
  boundary.
- **Notify kind.** `notify.kinds.ts`, `notify.controller`-adjacent template
  files (`templates/messages.en.ts`, `templates/messages.hi.ts`) and their
  tests gained one additive kind, `"support-ticket-created"` — outside this
  module's own boundary but required for the "emailed via the notify
  interface" requirement, same shape as the `export.completed` event edits
  `referrals/export-completed.event.ts` documents as its own precedent.

## What B13 (admin console) reads

`support_tickets` directly, per the brief ("admin side reads them in B13") —
this module does not expose an admin route. `status` (`open | in_progress |
resolved | closed`) is a plain string column B13 is expected to transition;
add a status-transition method here rather than writing to the table from
outside this module if/when B13 needs one.
