/**
 * The `PartnerCatalogue` interface (D04b scope §1) every adapter implements:
 * `MockPartnerCatalogue` (recorded fixtures) today, `EpidemicPartnerCatalogue`
 * (throws the H-28 contract gate until configured) once credentials land, and
 * — the point of the interface — any future partner without touching a
 * caller. Every method is workspace/asset scoped; nothing here ever returns a
 * raw partner file URL to a browser (D43: preview stream only,
 * `allowsRawFileDelivery: false`, always).
 */

/** A licence field set the partner API reports back with a search hit. */
export interface PartnerLicenceTerms {
  readonly licenceType: string;
  readonly territory: readonly string[];
  readonly termStart: string | null;
  readonly termEnd: string | null;
  readonly allowsCommercialUse: boolean;
  readonly allowsMonetisation: boolean;
  readonly allowsPaidAds: boolean;
  readonly allowsBroadcast: boolean;
  readonly requiresAttribution: boolean;
  readonly attributionText: string | null;
  readonly clearanceMethod: "channel_safelist" | "per_video_code" | "platform_covered";
  readonly requiresUsageReport: boolean;
}

export interface PartnerSearchFilters {
  readonly kind?: "sfx" | "music";
  readonly mood?: readonly string[];
  readonly minBpm?: number;
  readonly maxBpm?: number;
  readonly maxDurationMs?: number;
}

export interface PartnerSearchHit {
  readonly providerAssetId: string;
  readonly provider: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly mood: readonly string[];
  readonly bpm: number | null;
  readonly durationMs: number | null;
  readonly licence: PartnerLicenceTerms;
  /** D43: a partner result is a preview stream only, never a raw delivery. */
  readonly allowsRawFileDelivery: false;
}

export interface PartnerSearchResult {
  readonly hits: readonly PartnerSearchHit[];
  readonly total: number;
}

/** A short-lived stream reference — never a bare, unbounded partner URL. */
export interface PartnerStreamRef {
  readonly url: string;
  readonly expiresAt: string;
  /** True when `url` is a proxy through this API (B14 SSRF-safe fetch), not the partner's own signed URL. */
  readonly proxied: boolean;
}

export interface PartnerGrantRequest {
  readonly providerAssetId: string;
  readonly workspaceId: string;
  /** e.g. `"pass_item"`, `"cloud_render"` — echoed back on the grant row. */
  readonly useContext: string;
}

export interface PartnerGrant {
  readonly grantId: string;
  readonly providerAssetId: string;
  readonly workspaceId: string;
  readonly status: "pending" | "active" | "revoked" | "expired";
  readonly licence: PartnerLicenceTerms;
  readonly expiresAt: string | null;
}

export interface PartnerUsageReportRequest {
  readonly grantId: string;
  readonly exportId: string;
}

export interface PartnerUsageReportResult {
  readonly reportRef: string;
  readonly reportedAt: string;
}

/**
 * The contract every partner adapter implements. Pure network/API boundary —
 * no Prisma, no flag checks: `PartnerCatalogueService` is the one caller, and
 * the one place either happens (interface contract tests exercise adapters
 * directly, against this shape, with no database at all).
 */
export interface PartnerCatalogue {
  readonly providerName: string;
  search(query: string, filters?: PartnerSearchFilters): Promise<PartnerSearchResult>;
  stream(providerAssetId: string): Promise<PartnerStreamRef>;
  grant(request: PartnerGrantRequest): Promise<PartnerGrant>;
  reportUsage(request: PartnerUsageReportRequest): Promise<PartnerUsageReportResult>;
  revoke(grantId: string): Promise<void>;
}
