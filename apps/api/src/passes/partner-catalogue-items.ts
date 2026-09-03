import type { PartnerSearchHit } from "../partner-catalogue/partner-catalogue.types.js";

/**
 * Pass-wiring bridge from `PartnerSearchHit` (the partner catalogue's own
 * shape) to `sfxCatalogueOf`/`musicCatalogueOf`'s row shape (D04b2 scope
 * §2). Pure and side-effect-free so it can be unit tested with no flag, no
 * Prisma and no partner adapter — `passes.service.ts` only decides *whether*
 * to call these, never *how* the mapping works.
 *
 * A partner hit carries no embedding (the partner API returns catalogue
 * metadata, not a CLAP feature vector), so every partner row gets a
 * zero-length-matching, all-zero embedding — CLAP cosine ranking always
 * places it last rather than crashing on a dimension mismatch. `id` is
 * namespaced `partner:<providerAssetId>` so it can never collide with a
 * ulid-keyed `AudioAsset.id`, and `packId` is the fixed sentinel
 * `"partner-catalogue"` — there is no local pack row to point at.
 */
const PARTNER_EMBEDDING_DIMS = 512;
const PARTNER_PACK_ID = "partner-catalogue";

export function partnerRowId(providerAssetId: string): string {
  return `partner:${providerAssetId}`;
}

function zeroEmbedding(): readonly number[] {
  return new Array<number>(PARTNER_EMBEDDING_DIMS).fill(0);
}

function partnerLicenceSnapshot(hit: PartnerSearchHit): Record<string, unknown> {
  return {
    provider: hit.provider,
    providerAssetId: hit.providerAssetId,
    // TODO(H-28): see `partner-catalogue/licence-snapshot.ts` — the real
    // grant-time snapshot is stamped when a grant is created, not here; this
    // is only what the catalogue listing itself can show before a grant
    // exists.
    licenceType: hit.licence.licenceType,
    territory: hit.licence.territory,
    allowsCommercialUse: hit.licence.allowsCommercialUse,
    clearanceMethod: hit.licence.clearanceMethod,
    allowsRawFileDelivery: false,
    partner: true,
  };
}

export interface SfxCatalogueRow {
  readonly id: string;
  readonly packId: string;
  readonly cueType: string | null;
  readonly tags: string[];
  readonly embedding: readonly number[];
  readonly licenceSnapshot: Record<string, unknown>;
}

export interface MusicCatalogueRow {
  readonly id: string;
  readonly packId: string;
  readonly mood: string[];
  readonly bpm: number | null;
  readonly introMs: number | null;
  readonly outroMs: number | null;
  readonly durationMs: number | null;
  readonly embedding: readonly number[];
  readonly licenceSnapshot: Record<string, unknown>;
}

/** Maps `sfx`-kind partner hits (`bpm === null`, by the mock adapter's own convention) into `sfxCatalogueOf`'s row shape. */
export function partnerHitsToSfxRows(hits: readonly PartnerSearchHit[]): SfxCatalogueRow[] {
  return hits
    .filter((hit) => hit.bpm === null)
    .map((hit) => ({
      id: partnerRowId(hit.providerAssetId),
      packId: PARTNER_PACK_ID,
      cueType: null,
      tags: [...hit.tags],
      embedding: zeroEmbedding(),
      licenceSnapshot: partnerLicenceSnapshot(hit),
    }));
}

/** Maps `music`-kind partner hits (`bpm !== null`) into `musicCatalogueOf`'s row shape. */
export function partnerHitsToMusicRows(hits: readonly PartnerSearchHit[]): MusicCatalogueRow[] {
  return hits
    .filter((hit) => hit.bpm !== null)
    .map((hit) => ({
      id: partnerRowId(hit.providerAssetId),
      packId: PARTNER_PACK_ID,
      mood: [...hit.mood],
      bpm: hit.bpm,
      introMs: null,
      outroMs: null,
      durationMs: hit.durationMs,
      embedding: zeroEmbedding(),
      licenceSnapshot: partnerLicenceSnapshot(hit),
    }));
}
