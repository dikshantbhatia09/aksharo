import { z } from "zod";
import { zodDto } from "../common/index.js";

export type StockProviderType = "pexels" | "storyblocks" | "pixabay";
export type StockOrientationType = "portrait" | "landscape" | "square" | "all";
export type StockAspectRatioType = "9:16" | "16:9" | "1:1";

/**
 * Standardized Stock Media Asset DTO (ARCHITECTURE_AND_IMPLEMENTATION_PLAN §2.1).
 * Maps responses from Pexels, Pixabay, and Storyblocks into a unified representation.
 */
export interface StockAsset {
  readonly id: string;
  readonly provider: StockProviderType;
  readonly title: string;
  readonly durationSec: number;
  readonly thumbnailUrl: string;
  /** 480p fast MP4 for instantaneous hover preview */
  readonly previewVideoUrl: string;
  /** 1080p full MP4 for final composition and S3 edge caching */
  readonly downloadVideoUrl: string;
  readonly width: number;
  readonly height: number;
  readonly authorName?: string;
  readonly authorUrl?: string;
  readonly resolution?: string;
  readonly aspectRatio?: StockAspectRatioType;
  readonly tags?: readonly string[];
}

export const stockSearchSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    query: z.string().trim().max(100).optional(),
    orientation: z.enum(["portrait", "landscape", "square", "all"]).optional(),
    aspect: z.enum(["9:16", "16:9", "1:1", "all"]).optional(),
    category: z.string().trim().max(50).optional(),
    provider: z.enum(["pexels", "storyblocks", "pixabay", "all"]).optional(),
    page: z.coerce.number().int().min(1).max(50).optional(),
    perPage: z.coerce.number().int().min(1).max(50).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    minResolution: z.coerce.number().int().min(360).max(4320).optional(),
  })
  .strict();

export class StockSearchQueryDto extends zodDto(stockSearchSchema) {}

export interface StockSearchInput {
  readonly q?: string;
  readonly query?: string;
  readonly orientation?: StockOrientationType;
  readonly aspect?: StockAspectRatioType | "all";
  readonly category?: string;
  readonly provider?: StockProviderType | "all";
  readonly page?: number;
  readonly perPage?: number;
  readonly limit?: number;
  readonly minResolution?: number;
}

export interface StockSearchResponse {
  readonly items: readonly StockAsset[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly cached: boolean;
}

export const stockImportSchema = z
  .object({
    assetId: z.string().trim().min(1).max(128),
    provider: z.enum(["pexels", "storyblocks", "pixabay"]),
    downloadVideoUrl: z.string().url(),
    title: z.string().trim().max(200).optional(),
    projectId: z.string().trim().optional(),
    durationSec: z.number().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();

export class StockImportDto extends zodDto(stockImportSchema) {}

export interface StockImportResponse {
  readonly assetId: string;
  readonly provider: string;
  readonly cachedKey: string;
  readonly cachedUrl: string;
  readonly sizeBytes: number;
  readonly status: "ready";
}

export const STOCK_CATEGORIES: readonly string[] = Object.freeze([
  "All",
  "Technology",
  "Business",
  "Nature",
  "City",
  "Finance",
  "Real Estate",
  "Abstract",
  "Fitness",
  "Space",
  "Aerial",
  "Lifestyle",
]);
