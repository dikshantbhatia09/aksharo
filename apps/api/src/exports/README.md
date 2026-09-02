# `exports` — the decision engine, signed render manifests, cloud jobs, downloads (A21)

Everything between "the user clicks Export" and a file they can watch or download:
which path renders it, whether it carries a watermark, the server-signed instruction
that path obeys, the cloud job that does the work, and the record left behind.

Design references: `docs/CONTRACTS.md` §3, §4, §6; `docs/THREAT-MODEL.md` T10;
`03-architecture/04-pricing-and-monetization.md` §Plans, §Offers;
`03-architecture/05-system-architecture.md` §5.2; `12-redesign-decisions.md` D04,
D26, D30, D34; `packages/render-manifest/README.md`; `apps/render/README.md`.

## Endpoints

| Method   | Path                                      | Who    | Notes                                                  |
| -------- | ----------------------------------------- | ------ | ------------------------------------------------------ |
| `POST`   | `/projects/{id}/exports`                  | editor | Decides the path, issues a manifest or enqueues a job. |
| `POST`   | `/exports/manifests/{id}/complete`        | editor | Browser path only. Single-use nonce.                   |
| `GET`    | `/projects/{id}/exports`                  | viewer | Paged list.                                            |
| `GET`    | `/exports/{id}/download`                  | viewer | Short-lived R2 signed URL; 409 for a browser export.   |
| `POST`   | `/workspaces/{id}/brand-assets`           | editor | Presigned PUT for a watermark/logo PNG.                |
| `GET`    | `/workspaces/{id}/brand-assets`           | viewer | List.                                                  |
| `DELETE` | `/workspaces/{id}/brand-assets/{assetId}` | editor | Delete.                                                |

Every route is behind `WorkspaceMemberGuard` + `RolesGuard`; a project in another
workspace is a 404, not a 403 (THREAT-MODEL T5).

## The decision engine (`decision.ts`)

Pure, synchronous, table-tested (≥25 cases across plans, caps, capabilities and
modes). Two independent questions, decided from the same inputs:

1. **Path.** `mode:"cloud"|"browser"` is honoured when technically possible and
   refused (`export/unsupported_in_browser`) when an explicit `"browser"` is not;
   `"auto"` picks browser when eligible and falls back to cloud with the reason in
   `reasons[]`. Alpha and green-screen outputs, a mobile capability probe, and
   anything over the browser's technical length cap are always cloud (D34). A 4K
   request the plan does not carry is refused outright
   (`entitlement/upgrade_required`) before the path is even chosen — that is an
   entitlement, not a rendering decision.
2. **Watermark.** A plan whose `entitlements.watermark` is `"none"` never gets one.
   Otherwise (Free) the signup gift or an unconsumed ₹9 pass clears it, but only on
   the browser path and only ≤ 10 minutes (D04) — a cloud render, or anything
   longer, is watermarked regardless of either.

`reasons[]` are the sentences `POST /projects/{id}/exports` echoes back verbatim for
the export dialog (`08-ux-design-system.md` §Export dialog): "In this browser — no
upload", "Cloud render — 0.5 credits per output minute", and so on.

## The manifest is the only thing that authorises a render

`manifest-builder.ts` builds the `@montaj/render-manifest` document — the EDG
revision, the resolved style docs (content-hashed into `catalogueSnapshotIds`), the
primary media's storage key, a `@montaj/timemap` timemap over every accepted `cut`
item, the decision's caps and watermark — and `common/crypto/manifest-signer.ts`
signs it with `INTERNAL_CALLBACK_SECRET` (the canonical-JSON HMAC A20 defined, with
`_NEXT` accepted for verification during a rotation). **No client ever supplies caps
or a watermark**; both travel inside the signature (THREAT-MODEL T10).

- **Browser path:** the signed manifest is returned to the caller, who renders
  locally and never uploads. `export_manifests` and an `exports` row
  (`pending_browser`) are written at issuance.
- **Cloud path (video or subtitle):** the manifest is embedded in the `render.video`
  / `render.subtitle` job payload via the existing `JobsService.enqueue` (credits
  reserved at 0.5/output-minute, held on the _source_ duration); the `exports` row is
  written by the completion handler once the worker reports back, not before.

## Completion (`render-completion.handler.ts`)

Registers on `JobCompletionRegistry` exactly as `TranscribeCompletionHandler` does.
The manifest's nonce is claimed as the _first_ write (`consumed_at IS NULL` →
now) — idempotent against a retry after the handler throws, because a genuine
replay of an already-succeeded job never reaches the handler at all
(`JobsService.complete`'s own terminal-status guard). Video writes one `exports`
row, upserted on the manifest's own `exportId`; subtitle writes one row per sidecar
the worker produced. Both write a `publish_events` row (B06 reads it for the streak
experiment) and settle credits off the _rendered_ length — never more than the
hold.

## Downloads and retention

`GET /exports/{id}/download` presigns a 5-minute R2 GET; a browser export has no
`storageKey` (it never left the browser) and 409s `export/not_ready` instead.
`ExportsService.purgeExpiredExports()` deletes the R2 object and the row past the
7-day `expiresAt` (D47) — a method a scheduler calls, not a schedule of its own;
B16 wires it, the same convention `media/retention.service.ts` uses.

## Brand assets and the default watermark

A workspace's own logo lives at `ws/{workspaceId}/brand/{assetId}.png` (CONTRACTS
§6) and is offered as a deliberate overlay via `options.brandAssetId` — even on an
otherwise unwatermarked export.

The Free-tier mark is different: `apps/render`'s `brandAssetKey` resolves **every**
`watermark.assetId` per workspace, with no bundled, workspace-independent fallback
anywhere in the render path — proved by running the real worker in
`test/exports-render.e2e-spec.ts`, which failed `storage/unreadable` before this
existed. `default-watermark.service.ts` provisions a small synthesised placeholder
PNG at that key the first time a workspace needs it (`default-watermark.ts`; the
real Aksharo wordmark is a design asset outside this work package — swapping it in
later is a `put()` of new bytes at the same key, nothing about the render path or
the signed document changes).

## The ₹9 pass

`nine-pass-ledger.ts` is an interface with a no-op implementation, exactly the shape
CONTRACTS §4 describes for `CreditsFacade`'s Wave 1: `isAvailable` always answers
`false` until B04 backs it with `passes_purchased`, so a stub can never invent a
clean export nobody paid for.

## A reported deviation

The brief's original scope named an ES256/JWKS `GET
/.well-known/aksharo-manifest-keys.json` endpoint. That predates A20's landed
design: `@montaj/render-manifest` signs with a symmetric HMAC over
`INTERNAL_CALLBACK_SECRET`, not an asymmetric keypair, and publishing verification
material for an HMAC would hand out the ability to forge a manifest. This work
package does not implement that endpoint; every manifest — browser and cloud
alike — is issued and verified through `@montaj/render-manifest` as A20 built it.

## Layout

```
decision.ts                  the pure decision engine
manifest-builder.ts           builds the unsigned RenderManifest
projection.ts                 EDG -> RenderProjection, and the style snapshot
default-watermark.ts          the placeholder PNG's bytes
default-watermark.service.ts  provisions it per workspace
nine-pass-ledger.ts           the ₹9 pass interface + no-op
daily-cap.ts                  the Free-workspace browser-manifest abuse cap
exports.service.ts            orchestrates all of the above
exports.controller.ts         /projects/{id}/exports, /exports/*
brand-assets.service.ts       a workspace's own watermark/logo images
brand-assets.controller.ts    /workspaces/{id}/brand-assets
render-completion.handler.ts  what a render.video/render.subtitle completion means
exports.dto.ts                request/response shapes
exports.errors.ts             this module's error codes
exports.constants.ts          deployment-tunable numbers
```
