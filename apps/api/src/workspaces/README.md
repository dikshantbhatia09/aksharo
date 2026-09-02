# `workspaces`, `users`, `consents`, `privacy` — accounts and tenancy (A05)

Everything a person owns that is not a project: their profile and their rights
over it, the workspaces they work in, who else is in them, the tax profile every
invoice is later built from, and the entitlement that says what the workspace may
do.

Design references: `docs/CONTRACTS.md` §0, §5 and §8; `docs/THREAT-MODEL.md` T4;
`03-architecture/07-api-and-contracts.md` §Workspaces and §Privacy & rights;
`06-data-model.md` (users, workspaces, memberships, consent_records,
dsr_requests, access_logs); `04-pricing-and-monetization.md` §Tax;
`12-redesign-decisions.md` D41, D60, D61, D62, D70.

## Endpoints

| Method   | Path                                      | Who             | Notes                                                        |
| -------- | ----------------------------------------- | --------------- | ------------------------------------------------------------ |
| `GET`    | `/me`                                     | any member      | Profile plus the token's workspace and the caller's role.    |
| `PATCH`  | `/me`                                     | any member      | Name, avatar, locale, onboarding, marketing opt-in.          |
| `GET`    | `/me/data`                                | any member      | DPDP export; returns a single-use link valid one hour.       |
| `GET`    | `/me/data/{requestId}?token=`             | public (signed) | Redeems that link. Excluded from the OpenAPI document.       |
| `DELETE` | `/me`                                     | any member      | Erasure request; the cascade is B16.                         |
| `GET`    | `/consents`                               | any member      | Current answer per purpose plus `reconsentRequired`.         |
| `POST`   | `/consents`                               | any member      | Grant or withdraw one purpose.                               |
| `GET`    | `/privacy/notice`                         | public          | The itemised notice's version and purpose list.              |
| `GET`    | `/admin/parental-waitlist`                | platform admin  | Digests only; behind A08b's `AdminGuard` (`users.is_admin`). |
| `GET`    | `/workspaces`                             | any member      | The caller's workspaces. Not scoped to the `ws` claim.       |
| `POST`   | `/workspaces`                             | any member      | Creates a team or agency workspace; the caller owns it.      |
| `GET`    | `/workspaces/{id}`                        | viewer          |                                                              |
| `PATCH`  | `/workspaces/{id}`                        | admin           | Name, slug, settings (settings are merged).                  |
| `DELETE` | `/workspaces/{id}`                        | owner           | Soft delete; refused when it is the caller's only workspace. |
| `PUT`    | `/workspaces/{id}/tax-profile`            | owner           | Country, GST State, GSTIN, legal name.                       |
| `GET`    | `/workspaces/{id}/entitlement`            | viewer          | Free-plan stub, cached 60 s (B02 computes it for real).      |
| `GET`    | `/workspaces/{id}/members`                | viewer          | Members and outstanding invitations, owner first.            |
| `POST`   | `/workspaces/{id}/members`                | admin           | Invite an address.                                           |
| `PATCH`  | `/workspaces/{id}/members/{membershipId}` | admin           | Change a role.                                               |
| `DELETE` | `/workspaces/{id}/members/{membershipId}` | admin           | Remove a member or withdraw an invitation.                   |
| `GET`    | `/invitations`                            | any member      | Invitations waiting for the caller's verified address.       |
| `POST`   | `/invitations/{id}/accept`                | the invitee     | Joins; the caller then exchanges a token.                    |
| `DELETE` | `/invitations/{id}`                       | the invitee     | Declines.                                                    |

`@Roles("admin")` admits `admin` and `owner`, and `@Roles("owner")` admits only
the owner — the ladder is `viewer < editor < admin < owner` and a route names the
lowest role that may call it.

## The membership guard (THREAT-MODEL T4)

Every `/workspaces/:id` route wears `WorkspaceMemberGuard`, which asserts two
things and then hands over to `RolesGuard`:

1. **the id in the path is the `ws` claim of the access token.** The workspace
   context comes from the token and from nowhere else (07 §Conventions: "There is
   no `X-Workspace-Id` header"). A path segment is another attacker-supplied
   string, so without this check the path becomes the header by another name.
   Switching workspace goes through `POST /auth/token/exchange`, which re-checks
   membership and mints a new session.
2. **an active membership still exists**, and the guard replaces the principal's
   `role` with the one it read. The `role` claim is a fifteen-minute assertion
   made when the token was minted; re-reading it means a demotion or a removal
   bites on the next request rather than at the end of the token's life.

Both failures answer **403 `auth/not_a_member`**, never 404: the id came out of
the caller's own token, so there is nothing to enumerate, and a 404 would make
"no such workspace" and "you were just removed" indistinguishable to the person
who was removed.

`test/workspace-guard.e2e-spec.ts` does not check a list somebody wrote down — it
**enumerates the shipped route table** from the Express router underneath Nest,
filters it to the `:id` routes, and drives a real request at every one of them as
a stranger, as a removed member, and with no token at all. A route added without
the guard fails there without anybody editing the test.

`/invitations` is deliberately a separate collection: an invitee is by definition
not yet a member, and their token points at whichever workspace they were already
in, so the guard would refuse every one of those requests. Keeping them off
`/workspaces/{id}` keeps the guard's rule absolute instead of carving an
exception into it.

## The tax profile (D41)

India makes the customer's **State** a mandatory validated field on every purchase
(Circular 242/36/2024-GST): it is the address on record that fixes the place of
supply, so a free-text state is a wrong invoice waiting to happen.

| Field              | Rule                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| `billingCountry`   | ISO-3166-1 alpha-2. Drives everything else.                                        |
| `billingStateCode` | Two digits. **Required** for India, from the 36 live codes; **refused** elsewhere. |
| `gstin`            | Optional. Shape, base-36 check digit, and its State must equal `billingStateCode`. |
| `legalName`        | Optional; the name printed on the invoice.                                         |
| `currency`         | Derived: `IN → INR`, otherwise `USD`. Locked once a subscription exists.           |
| `region`           | Derived: `IN → in`, EU/EEA → `eu`, otherwise `us` (THREAT-MODEL T24).              |

`gst-state-codes.ts` is the 36-entry list — 28 States and 8 Union Territories.
Four codes that appear in older tables are deliberately absent, because nobody can
be in them today: `25` (Daman and Diu, merged into `26` in 2020), `28` (old Andhra
Pradesh, replaced by `37`), and `97`/`99`, which are the GST portal's own
administrative buckets rather than a customer address.

`gstin.ts` implements the GSTN check digit: base 36 over `0-9A-Z`, weights
alternating 1 and 2 from the left, each product folded back with
`floor(p/36) + (p%36)`, and the digit that brings the total to a multiple of 36 —
Luhn, in base 36. It is worth the twenty lines because the field is typed by hand
and a transposition produces a _plausible_ GSTIN that only fails months later, on
a return, when the invoice can no longer be reissued.

### Confirmed, versus guessed

Sign-up has a jurisdiction (the age gate needs it) but no billing address, and
`workspaces.billing_country` is `NOT NULL` — so A04 writes a **guess**
(`IN → IN`, `EU → DE`, `OTHER → US`). A05 adds `billing_country_confirmed_at`,
which is null until a human states where they are billed by calling
`PUT /workspaces/{id}/tax-profile`. B01 refuses to open a checkout while it is
null, so a guess can never reach an invoice.

The **currency** is a separate lock: once the workspace has a subscription in a
live state, a country change that would move the currency is refused with
`workspace/tax_profile_locked`, because the next invoice would otherwise disagree
with the mandate that pays it. Everything else on the profile stays editable.

## Memberships

An invitation is a `memberships` row with `status: invited` and `user_id` null —
which is what makes "invited, but has never signed up" expressible at all. It
becomes a membership only when the invitee accepts it **from their own verified
address**; the id in the link is a lookup key, not a bearer secret, so a leaked
link admits nobody. Accepting does not move the caller's session: the response
names the workspace and the client exchanges a token for it.

Invariants enforced here rather than by convention:

- exactly one owner, who cannot be demoted or removed (`workspaces.owner_id` is a
  `NOT NULL` foreign key, so a workspace without one is unrepresentable);
- nobody may grant a role above their own, or an `admin` would be an `owner`
  reachable in two requests;
- removing a member revokes every session they hold **in that workspace** at once,
  because a fifteen-minute access token would otherwise outlive their access.

`seatBilled` is written and never charged: B08 owns seat billing and needs the
field to already mean something when it arrives. `MAX_MEMBERS_PER_WORKSPACE` (50)
is a holding limit for the same reason.

## Consent (D61, D62)

`consent_records` is **append-only**. Granting, withdrawing and re-granting each
write a row; the current answer is the newest row for the purpose. A refusal is a
row too, because the notice-and-choice record has to show what was _asked_ as well
as what was agreed. Withdrawal additionally stamps `withdrawnAt` on the grants it
closes, so "when did this stop applying" is answerable without replaying the log.

`marketingOptIn`, `analyticsConsentAt` and `memoryConsentAt` on `users` are
mirrors for the hot path, written in the same transaction as the row. The rows
stay authoritative.

`GET /consents` reports `reconsentRequired` when any answer was given against an
older notice version — which is what "notice and choice" means when the notice
changes.

## Rights requests (D70)

| Route          | What it does now                                                                             | What is still coming     |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------------ |
| `GET /me/data` | `dsr_requests` row of kind `export`, bundle built inline, single-use link valid one hour.    | Media, transcripts (B16) |
| `DELETE /me`   | `dsr_requests` row of kind `erasure`, `deletedAt` set, address anonymised, sessions revoked. | The cascade (B16)        |

Both stamp `dueAt` 30 days out (DPDP Rule 14). Erasure is idempotent: a second
call returns the request already open rather than filling the table with copies of
the same demand. The anonymised address is `deleted-{userId}@deleted.invalid` —
`users.email` is `UNIQUE NOT NULL` so erasure cannot blank it, and `.invalid` is
reserved by RFC 2606, so nothing can ever be delivered there and no future sign-up
can collide with it.

Two provisional choices in the export, both one-line swaps:

- the bundle is **built inline** rather than on a queue, because CONTRACTS §3 has
  no queue for a rights export and the build is a dozen indexed reads at Wave-1
  volumes. `DataExportService.build()` is what B16's job will call.
- the object lives in **Redis** under the SHA-256 of its download token, because
  the API has no object-store client until A06. `dsr_requests.evidence_key`
  already records the R2 key the object will have.

The link carries 256 bits of one-time entropy, is spent on first read, and expires
in an hour; the stored copy is addressed by the token's _hash_, so a Redis dump
hands nobody a working link.

## The entitlement stub

`GET /workspaces/{id}/entitlement` returns the seeded **Free** plan's
entitlements for every workspace, cached in Redis for 60 seconds (07 pins the
cache). B02 replaces the body of `EntitlementService.compute()` — plan, plus the
seats a subscription pays for, plus purchased passes, plus flags, plus the grace
window a failed renewal opens — and nothing else. Guessing at that now would
produce a second, wrong implementation for B02 to delete. The cache is in Redis
rather than in process because two API instances must not disagree about what a
workspace may do; a Redis outage degrades to computing every time.

## The parental waiting list (D60)

A04 had nowhere durable for these: `06-data-model.md` has no table and the schema
was frozen outside A03, so entries went into the Redis hash
`montaj:auth:parental-waitlist`. A05 adds `parental_waitlist` and
`ParentalWaitlistService` drains that hash into it **at boot** — idempotent (the
unique index on `email_hash` absorbs a repeat), best effort (an unreachable Redis
must not stop the API booting; the next boot tries again), and the hash is deleted
only once every field has been written.

Only `sha256(address)` is stored. The list exists to answer "how many people are
waiting, and where" and, once the parental-consent flow ships, to match an address
a person types back to a row. Keeping the plaintext address of a declared minor
for two years to send one message is not a trade worth making.
`POST /auth/parental-waitlist` gained an optional `jurisdiction` so the sign-up
form the age gate refused can carry over what it already knows.

The list is read at `GET /admin/parental-waitlist`, which lives in `AdminModule`
rather than beside the rest of this surface: it belongs to nobody's workspace, so
there is no membership that could authorise reading it, and A08b's rule is that
every route crossing a tenant boundary sits behind `AdminGuard` in that module,
where it cannot be registered without one. `AdminGuard` re-reads `users.is_admin`
on each request, so revoking platform-staff access takes effect immediately
(THREAT-MODEL T20).

## Audit (05 §8, THREAT-MODEL T20)

Every mutating route writes both trails through `AuditService` (owned by
`UsersModule`, which is why `workspaces`, `consents` and `privacy` all import it):
`audit_log` for the administrative record and `access_logs` for the one-year
"who touched what" of D61 Rule 6. Actions are named `<domain>.<noun>.<verb>` and
listed in `A05_AUDIT_ACTIONS`. A failure to write is logged at `error` and
swallowed — an unavailable audit table must not become a way to deny somebody
their own profile — exactly as `AuthAuditService` does, and X01 re-verifies that
trade-off before Gate C.

## Notifications

`WORKSPACE_NOTIFIER` is the port every message goes through. It is bound to
`LoggingWorkspaceNotifier`, which logs (address masked) and, outside production,
pushes onto the same development outbox `AuthMailerService` uses. A25 owns
delivery and swaps the one `useClass` for a `notify`-queue producer, exactly as
B02 swaps `CREDITS_FACADE`.

## Configuration

No new environment variables. One `FEATURE_FLAGS_JSON` key:

| Key                      | Default | Effect                                                                          |
| ------------------------ | ------- | ------------------------------------------------------------------------------- |
| `privacy.platformAdmins` | absent  | Addresses allowed to read `GET /privacy/parental-waitlist`. Closed when absent. |

There is no platform administrator in the data model — `memberships.role` is
scoped to a workspace, and the separate admin application with its own guard, MFA
and least-privilege roles is B13 (T20). One route needs the concept before then,
so it reads the CONTRACTS §1 flag blob rather than inventing a column or an
environment variable B13 would have to unpick.

## What A05 does not do

Seat billing and licence keys (B08), the erasure cascade and the full export
bundle (B16), real entitlement computation (B02), checkout and GSTIN verification
against the GSTN (B01), ownership transfer, the admin console (B13), and mail
delivery (A25).
