import { z } from "zod";

/** `GET /audio-assets/{assetId}/url` response (D04d). */
export const packAssetUrlSchema = z.object({
  assetId: z.string(),
  url: z.string(),
  /** ISO-8601 instant the URL stops working (`PACK_ASSET_URL_TTL_SECONDS` out). */
  expiresAt: z.string(),
});

export type PackAssetUrl = z.infer<typeof packAssetUrlSchema>;
