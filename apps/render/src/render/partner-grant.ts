/**
 * D04b2 scope §4: `apps/render`'s half of the partner-catalogue grant check.
 *
 * `apps/api/src/passes/partner-catalogue-items.ts` stamps every partner-
 * catalogue `sfx`/`music` catalogue row with `packId: "partner-catalogue"`
 * (its own `PARTNER_PACK_ID` sentinel) and `id: "partner:<providerAssetId>"`
 * (its `partnerRowId()`). Those two conventions are how a render manifest's
 * `SfxTrack`/`MusicTrack` — which carries the accepted item's `packId` and
 * `assetId` straight through from the catalogue row the pass picked — can be
 * recognised as a partner asset downstream, with no schema change to
 * `packages/render-manifest` (outside this work package's file boundary).
 *
 * `apps/render` never trusts a manifest's own say-so that a partner asset is
 * cleared: before downloading the pack object, it calls back to the API's
 * signed internal surface (`PartnerCatalogueController`'s internal sibling,
 * `POST /internal/partner-catalogue/verify-grant`) and refuses to render if
 * the grant does not verify as active — matching the same "never trust the
 * caller" posture `InternalMediaController`'s `assertOwnKeys` documents.
 */
export const PARTNER_CATALOGUE_PACK_ID = "partner-catalogue";

const PARTNER_ID_PREFIX = "partner:";

/** Whether a manifest track's `packId` marks it as sourced from the partner catalogue. */
export function isPartnerCatalogueTrack(packId: string): boolean {
  return packId === PARTNER_CATALOGUE_PACK_ID;
}

/** `"partner:mock-sfx-0001"` → `"mock-sfx-0001"` — the id the partner API itself uses. */
export function providerAssetIdFromTrackAssetId(assetId: string): string {
  return assetId.startsWith(PARTNER_ID_PREFIX) ? assetId.slice(PARTNER_ID_PREFIX.length) : assetId;
}

export type VerifyPartnerGrant = (input: {
  readonly workspaceId: string;
  readonly providerAssetId: string;
}) => Promise<boolean>;

/**
 * Refuses (throws) unless the track is not a partner asset, or verifies as
 * grant-covered. Fails closed: no `verify` function configured is treated
 * exactly like a `false` verification — never like "skip the check."
 */
export async function assertPartnerGrantForTrack(
  track: { readonly packId: string; readonly assetId: string },
  workspaceId: string,
  verify: VerifyPartnerGrant | undefined,
): Promise<void> {
  if (!isPartnerCatalogueTrack(track.packId)) return;
  const providerAssetId = providerAssetIdFromTrackAssetId(track.assetId);
  const allowed = verify !== undefined ? await verify({ workspaceId, providerAssetId }) : false;
  if (!allowed) {
    throw new Error(
      `partner catalogue grant not valid for asset ${providerAssetId} in workspace ${workspaceId}; refusing to render`,
    );
  }
}
