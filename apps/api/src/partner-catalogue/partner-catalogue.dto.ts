import { z } from "zod";

/** `GET /partner-catalogue/search` query (D04b2). */
export const partnerSearchQuerySchema = z.object({
  /** Empty matches every fixture hit — the mock adapter's own convention. */
  q: z.string().max(200),
  kind: z.enum(["sfx", "music"]).optional(),
  minBpm: z.coerce.number().int().min(0).max(400).optional(),
  maxBpm: z.coerce.number().int().min(0).max(400).optional(),
  maxDurationMs: z.coerce.number().int().min(0).optional(),
});
export type PartnerSearchQuery = z.infer<typeof partnerSearchQuerySchema>;

const partnerLicenceTermsSchema = z.object({
  licenceType: z.string(),
  territory: z.array(z.string()),
  termStart: z.string().nullable(),
  termEnd: z.string().nullable(),
  allowsCommercialUse: z.boolean(),
  allowsMonetisation: z.boolean(),
  allowsPaidAds: z.boolean(),
  allowsBroadcast: z.boolean(),
  requiresAttribution: z.boolean(),
  attributionText: z.string().nullable(),
  clearanceMethod: z.enum(["channel_safelist", "per_video_code", "platform_covered"]),
  requiresUsageReport: z.boolean(),
});

const partnerSearchHitSchema = z.object({
  providerAssetId: z.string(),
  provider: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  mood: z.array(z.string()),
  bpm: z.number().nullable(),
  durationMs: z.number().nullable(),
  licence: partnerLicenceTermsSchema,
  allowsRawFileDelivery: z.literal(false),
});

/** `GET /partner-catalogue/search` response (D04b2). */
export const partnerSearchResultSchema = z.object({
  hits: z.array(partnerSearchHitSchema),
  total: z.number(),
});
export type PartnerSearchResultDto = z.infer<typeof partnerSearchResultSchema>;

/** `POST /partner-catalogue/grants` body (D04b2). */
export const createPartnerGrantSchema = z.object({
  providerAssetId: z.string().min(1),
  /** e.g. `"pass_item"`, `"cloud_render"` — echoed back on the grant row. */
  useContext: z.string().min(1).max(64),
});
export type CreatePartnerGrantDto = z.infer<typeof createPartnerGrantSchema>;

/** `POST /partner-catalogue/grants` response (D04b2). */
export const partnerGrantResultSchema = z.object({
  grantId: z.string(),
  licenceSnapshot: z.record(z.string(), z.unknown()),
});
export type PartnerGrantResultDto = z.infer<typeof partnerGrantResultSchema>;
