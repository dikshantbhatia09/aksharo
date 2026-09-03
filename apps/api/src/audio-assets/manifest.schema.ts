import { z } from "zod";

/**
 * The audio-pack manifest schema (D04a). One manifest per pack — the
 * synthetic fixture pack today (`fixtures/audio-pack/manifest.json`), the
 * real commissioned Tier 0 pack (A00-07) tomorrow, through the same shape.
 *
 * Field names mirror `AudioAsset`'s typed licence columns 1:1 (D44) so the
 * ingest CLI can spread a validated manifest entry almost directly into a row
 * — the only computed fields are `id` (minted, not taken from the manifest,
 * so re-ingesting under a different Montaj id is never possible by accident),
 * `embedding`, `integratedLufs`/`truePeakDb`/`durationMs` (measured) and
 * `storageKey` (assigned by the ingest CLI, not authored).
 */

export const audioAssetKindSchema = z.enum(["sfx", "music"]);

export const audioProviderSchema = z.enum([
  "owned",
  "epidemic",
  "soundstripe",
  "storyblocks",
  "beatoven",
  "hoopr",
]);

export const catalogueModeSchema = z.enum(["mirrored", "live_fetch"]);

export const clearanceMethodSchema = z.enum([
  "none",
  "channel_safelist",
  "per_video_code",
  "platform_covered",
]);

/** Functional cue tags only — never a meme name (D44, 09-ai-pipeline §6). */
export const cueTypeSchema = z.enum([
  "impact",
  "whoosh",
  "pop",
  "ding",
  "riser",
  "boom",
  "comedic",
  "notification",
]);

export const manifestAssetSchema = z.object({
  /** Pack-local id, unique within the manifest; combined with the pack id to
   * form the idempotency key (`provider` + `providerAssetId`). */
  id: z.string().min(1).max(128),
  kind: audioAssetKindSchema,
  cueType: cueTypeSchema.optional(),
  title: z.string().min(1).max(200),
  tags: z.array(z.string().min(1)).default([]),
  mood: z.array(z.string().min(1)).default([]),
  bpm: z.number().int().positive().optional(),
  musicalKey: z.string().max(16).optional(),
  /** Path to the source WAV, relative to the manifest file. */
  filePath: z.string().min(1),

  provider: audioProviderSchema.default("owned"),
  catalogueMode: catalogueModeSchema.default("mirrored"),
  licenceType: z.string().max(64).optional(),
  licensor: z.string().max(200).optional(),
  licenceRef: z.string().max(500).optional(),
  licenceVersion: z.string().max(32).optional(),
  territory: z.array(z.string().min(1).max(8)).min(1).default(["WORLD"]),
  termStart: z.string().datetime().optional(),
  termEnd: z.string().datetime().optional(),
  allowsCommercialUse: z.boolean().default(false),
  allowsMonetisation: z.boolean().default(false),
  allowsPaidAds: z.boolean().default(false),
  allowsBroadcast: z.boolean().default(false),
  allowsRawFileDelivery: z.boolean().default(false),
  allowsOfflineCache: z.boolean().default(false),
  allowsEmbeddingIndex: z.boolean().default(true),
  allowsAiTraining: z.boolean().default(false),
  requiresAttribution: z.boolean().default(false),
  attributionText: z.string().max(500).optional(),
  clearanceMethod: clearanceMethodSchema.default("none"),
  contentIdRegistered: z.boolean().default(false),
  requiresUsageReport: z.boolean().default(false),
  reportEndpoint: z.string().url().optional(),
});

export const manifestSchema = z.object({
  pack: z.object({
    id: z.string().min(1).max(128),
    owner: z.string().min(1).max(200),
    licenceRef: z.string().min(1).max(500),
    version: z.string().min(1).max(32),
    kind: audioAssetKindSchema,
  }),
  assets: z.array(manifestAssetSchema).min(1),
});

export type ManifestAsset = z.infer<typeof manifestAssetSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

/** Ids must be unique within a single manifest (they become `providerAssetId`). */
export function validateManifest(input: unknown): Manifest {
  const manifest = manifestSchema.parse(input);
  const seen = new Set<string>();
  for (const asset of manifest.assets) {
    if (seen.has(asset.id)) {
      throw new Error(`duplicate asset id in manifest: ${asset.id}`);
    }
    seen.add(asset.id);
  }
  return manifest;
}
