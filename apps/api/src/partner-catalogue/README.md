# `partner-catalogue` — D04b

Partner (Epidemic Sound-shaped) audio catalogue integration, built dark
behind `assets.partnerCatalogue` (`FEATURE_FLAGS_JSON`, default **off**)
while H-28 — the signed partner contract and its API credentials — is still
open. See `_orchestration/D04b-partner-catalogue.md` for the brief and its
2026-09-03 launch-ruling addendum.

## Why `FEATURE_FLAGS_JSON`, not a new `PARTNER_CATALOGUE` env var

The brief names `PARTNER_CATALOGUE=off|mock|epidemic`. `docs/CONTRACTS.md`
§1's `CONTRACT_ENV_VARS` list is frozen and out of this work package's file
boundaries, so this module reuses the existing `FEATURE_FLAGS_JSON`
mechanism (the same one `auth/breached-password.service.ts` and
`invoices/invoices.service.ts` use) instead:

- `assets.partnerCatalogue: true` — turns the whole feature on.
- `assets.partnerCatalogueProvider: "epidemic"` — selects the real adapter;
  anything else (including absent) selects `"mock"`.

## The interface

```ts
interface PartnerCatalogue {
  readonly providerName: string;
  search(query: string, filters?: PartnerSearchFilters): Promise<PartnerSearchResult>;
  stream(providerAssetId: string): Promise<PartnerStreamRef>;
  grant(request: PartnerGrantRequest): Promise<PartnerGrant>;
  reportUsage(request: PartnerUsageReportRequest): Promise<PartnerUsageReportResult>;
  revoke(grantId: string): Promise<void>;
}
```

Two adapters implement it:

- **`MockPartnerCatalogue`** — in-memory, two fixture hits (an SFX whoosh, a
  music bed), shaped after Epidemic Sound's publicly documented Partner API
  field names. Every id and title is invented for this fixture; nothing here
  is ever written to `prisma/seed-data.ts` (2026-09-03 addendum: "no partner
  asset shipped in fixtures").
- **`EpidemicPartnerCatalogue`** — the real adapter skeleton. Every method
  throws `partner-catalogue/contract_gate` (`H28_CONTRACT_GATE_TEXT`) until
  `EPIDEMIC_PARTNER_API_KEY`/`EPIDEMIC_PARTNER_API_SECRET` are both set —
  proven by `epidemic-partner-catalogue.test.ts`. When H-28 signs, this is
  the one file a follow-up PR fills in; no caller of `PartnerCatalogue`
  changes.

`PartnerCatalogueService` is the only thing that ever flag-gates or touches
Prisma. It selects the adapter, refuses every call with
`partner-catalogue/disabled` while the flag is off, and persists grants to
the D04a `asset_clearance_grants` table (this work package added `asset_id`,
`use_context`, `licence_snapshot` columns to it rather than creating a
parallel table).

## The licence snapshot is a placeholder until H-28

`licence-snapshot.ts`'s `buildLicenceSnapshot()` always writes
`licenceType: "TODO(H-28)"` and `pending: true`, regardless of what the
adapter reports — a downstream reader can find every placeholder with one
query on `licence_snapshot->>'licenceType' = 'TODO(H-28)'`. The addendum is
explicit: "when H-28 closes, the only change should be data + flag" — this
function is the one place that data changes.

## The D43 refusal (works today, flag off)

`../audio-assets/asset-allowed.ts`'s `assetAllowed()` now takes
`partnerCatalogueEnabled` (default refuse) and adds the
`partner-catalogue-disabled` reason for any non-`owned` asset while it is
false — on every surface, `cloud_render` included. `../exports/decision.ts`'s
`decideExport()` takes `hasPartnerCatalogueAssets` and refuses the browser
export path unconditionally when true (D43: partner assets are
cloud-render-only). Both are proven with property/unit tests and need no
flag, no database, and no partner data to exercise.

## D04b2: the HTTP surface, pass wiring, usage emission, render check, admin table, badge

D04b built the interface, grant lifecycle and refusal proofs; nothing
exposed or used them. D04b2 closed that gap:

- **HTTP surface** (`partner-catalogue.controller.ts`): `GET
/partner-catalogue/search`, `POST /partner-catalogue/grants`, `DELETE
/partner-catalogue/grants/{grantId}` — workspace-member-gated,
  rate-limited, 404 (not 403) while the flag is off, audit-logged on
  create/revoke. `internal-partner-grant.controller.ts` adds the signed
  internal sibling `POST /internal/partner-catalogue/verify-grant`,
  `apps/render`'s pre-download check.
- **Pass wiring** (`../passes/partner-catalogue-items.ts` +
  `passes.service.ts`): `sfxCatalogueOf`/`musicCatalogueOf` append mock
  partner hits, mapped through a pure bridge, only while the flag is on.
- **Usage emission** (`usage-emission.ts` + `../exports/
render-completion.handler.ts`): `render.video` completion reports usage
  for every not-yet-exported `AssetUsage` row carrying a
  `clearanceGrantId`, leaving exactly the row shape
  `PartnerUsageReportRetryTask` already sweeps on failure.
  `apps/render/src/render/partner-grant.ts`: the render-side grant check —
  fails closed (refuses to download) on anything but an explicit
  `{ allowed: true }` from the internal endpoint.
- **Admin table** (`../admin/partner-catalogue/
admin-partner-catalogue.controller.ts` +
  `PartnerCatalogueService.listGrants`/`adminRevoke`): works even while the
  flag is off for a workspace, so staff can always see/revoke what it
  holds. `apps/web/app/(admin)/admin/partner-catalogue/page.tsx` is the
  table.
- **Web badge** (`apps/web/components/editor/passes/ProposalCard.tsx`): a
  "Partner — cloud render only" badge, read from
  `payload.licenceSnapshot.partner === true`.

Still not built — H-28 itself (the signed partner contract) and its real
adapter's field-mapping, which is `epidemic-partner-catalogue.ts`'s own
follow-up once credentials exist.
