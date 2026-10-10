/**
 * Trend-Aware Hashtag Recommendation Engine Types (Pillar 7 §03).
 */

export type HashtagTier = "BROAD" | "COMMUNITY" | "NICHE";

export type HashtagDomain =
  | "ai"
  | "tech"
  | "business"
  | "finance"
  | "marketing"
  | "creator_economy"
  | "productivity"
  | "fitness"
  | "gaming"
  | "crypto"
  | "comedy"
  | "education"
  | "food"
  | "travel"
  | "fashion";

export interface HashtagEntry {
  readonly tag: string;
  readonly domain: HashtagDomain;
  readonly tier: HashtagTier;
  readonly estimatedVolume: string; // e.g. "25M+", "450k", "45k"
  readonly postCountTier: number;   // estimated numerical post order: 10_000_000+, 500_000, 50_000
  readonly keywords: readonly string[]; // triggering entities, stems, and synonyms
}

export interface DomainTaxonomy {
  readonly domain: HashtagDomain;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly broadTags: readonly HashtagEntry[];
  readonly communityTags: readonly HashtagEntry[];
  readonly nicheTags: readonly HashtagEntry[];
}

export type DestinationPlatform = "youtube" | "instagram" | "tiktok" | "linkedin" | "x" | "default";

export interface PlatformHashtagRule {
  readonly platform: DestinationPlatform;
  readonly minTags: number;
  readonly maxTags: number;
  readonly recommendedTags: number;
  readonly broadRatio: number;      // e.g. 0.25 (1-2 tags)
  readonly communityRatio: number;  // e.g. 0.50 (3-4 tags)
  readonly nicheRatio: number;      // e.g. 0.25 (2-3 tags)
  readonly bannedKeywords?: readonly string[]; // e.g. #fyp, #viral for LinkedIn
}

export interface PyramidBundle {
  readonly broad: readonly string[];      // Tier 1 (1–2 tags)
  readonly community: readonly string[];  // Tier 2 (3–4 tags)
  readonly niche: readonly string[];      // Tier 3 (2–3 tags)
  readonly all: readonly string[];        // Combined, ordered: Broad -> Community -> Niche
  readonly formatted: string;             // Space-separated string: "#Tag1 #Tag2 #Tag3"
  readonly domain: HashtagDomain;
  readonly platform: DestinationPlatform;
}
