import { z } from "zod";
import { zodDto } from "../common/index.js";

export const STICKER_PROVIDERS = ["giphy", "tenor", "curated"] as const;
export type StickerProviderType = (typeof STICKER_PROVIDERS)[number];

export const STICKER_CONTENT_TYPES = ["sticker", "gif", "meme", "all"] as const;
export type StickerContentType = (typeof STICKER_CONTENT_TYPES)[number];

export const STICKER_CATEGORIES: readonly string[] = Object.freeze([
  "All",
  "Shocked Reactions",
  "Arrows & Pointers",
  "Viral Memes",
  "Laughing & LOL",
  "Money & Flex",
  "Mind Blown",
  "Celebration & Win",
  "Fail & Facepalm",
  "Glowing Effects",
  "Dead & Skull",
  "Text Slang",
]);

export interface StickerItem {
  readonly id: string;
  readonly provider: StickerProviderType;
  readonly type: "sticker" | "gif" | "meme";
  readonly title: string;
  readonly url: string;
  readonly previewUrl: string;
  readonly width: number;
  readonly height: number;
  readonly isTransparent: boolean;
  readonly sourceUrl?: string;
  readonly tags: readonly string[];
}

export const stickerSearchSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    query: z.string().trim().max(100).optional(),
    type: z.enum(STICKER_CONTENT_TYPES).optional(),
    provider: z.enum(["giphy", "tenor", "curated", "all"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export class StickerSearchQueryDto extends zodDto(stickerSearchSchema) {}

export const stickerTrendingSchema = z
  .object({
    type: z.enum(STICKER_CONTENT_TYPES).optional(),
    provider: z.enum(["giphy", "tenor", "curated", "all"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

export class StickerTrendingQueryDto extends zodDto(stickerTrendingSchema) {}

export const stickerRecommendSchema = z
  .object({
    transcript: z.string().trim().max(5000).optional(),
    sentiment: z.string().trim().max(50).optional(),
    limit: z.coerce.number().int().min(1).max(10).optional(),
  })
  .strict();

export class StickerRecommendDto extends zodDto(stickerRecommendSchema) {}

export interface StickerRecommendation {
  readonly sticker: StickerItem;
  readonly reason: string;
  readonly sentiment: string;
  readonly suggestedStartSec?: number;
  readonly suggestedDurationSec?: number;
}

export interface StickerRecommendResponse {
  readonly recommendations: readonly StickerRecommendation[];
}

export interface StickerSearchResponse {
  readonly assets: readonly StickerItem[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly categories: readonly string[];
}

export const stickerCacheSchema = z
  .object({
    assetId: z.string().trim().min(1).max(128),
    sourceUrl: z.string().url(),
    provider: z.string().trim().min(1).max(50),
    type: z.string().trim().min(1).max(50),
    isTransparent: z.boolean().optional(),
    projectId: z.string().trim().optional(),
    title: z.string().trim().max(200).optional(),
  })
  .strict();

export class StickerCacheDto extends zodDto(stickerCacheSchema) {}

export interface StickerCacheResponse {
  readonly cachedKey: string;
  readonly cachedUrl: string;
  readonly isTransparent: boolean;
  readonly format: string;
  readonly sizeBytes: number;
}
