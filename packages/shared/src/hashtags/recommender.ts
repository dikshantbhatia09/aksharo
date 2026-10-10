/**
 * Trend-Aware Hashtag Recommendation Engine (Pillar 7 §03).
 *
 * Implements the 3-Tier Pyramid Assembler:
 *   - Tier 1: Broad Category (1–2 tags, 10M+ posts)
 *   - Tier 2: Community Subculture (3–4 tags, 100k–1M posts)
 *   - Tier 3: Hyper-Niche Subject (2–3 tags, < 100k posts)
 *
 * Respects platform count throttles and tone guidelines:
 *   - YouTube Shorts: 3–5 tags (max 5)
 *   - Instagram Reels: 5–8 tags (max 8)
 *   - TikTok: 3–6 tags (max 6)
 *   - LinkedIn: 2–3 tags (max 3, bans #fyp / #viral spam)
 *   - X (Twitter): 1–3 tags (max 3)
 */

import { TAXONOMY_DATA } from "./taxonomy.js";
import type {
  DestinationPlatform,
  HashtagDomain,
  HashtagEntry,
  HashtagTier,
  PlatformHashtagRule,
  PyramidBundle,
} from "./types.js";

export const PLATFORM_HASHTAG_RULES: Record<DestinationPlatform, PlatformHashtagRule> = {
  youtube: {
    platform: "youtube",
    minTags: 3,
    maxTags: 5,
    recommendedTags: 4,
    broadRatio: 0.25,      // 1 tag
    communityRatio: 0.50,  // 2 tags
    nicheRatio: 0.25,      // 1 tag
  },
  instagram: {
    platform: "instagram",
    minTags: 5,
    maxTags: 8,
    recommendedTags: 7,
    broadRatio: 0.28,      // 2 tags
    communityRatio: 0.43,  // 3 tags
    nicheRatio: 0.29,      // 2 tags
  },
  tiktok: {
    platform: "tiktok",
    minTags: 3,
    maxTags: 6,
    recommendedTags: 5,
    broadRatio: 0.20,      // 1 tag
    communityRatio: 0.60,  // 3 tags
    nicheRatio: 0.20,      // 1 tag
  },
  linkedin: {
    platform: "linkedin",
    minTags: 2,
    maxTags: 3,
    recommendedTags: 3,
    broadRatio: 0.33,      // 1 tag
    communityRatio: 0.67,  // 2 tags
    nicheRatio: 0.00,      // 0 tags (prioritizes professional community hubs)
    bannedKeywords: ["#fyp", "#viral", "#foryou", "#trending", "#tiktok", "#reels", "#explore"],
  },
  x: {
    platform: "x",
    minTags: 1,
    maxTags: 3,
    recommendedTags: 2,
    broadRatio: 0.50,      // 1 tag
    communityRatio: 0.50,  // 1 tag
    nicheRatio: 0.00,
  },
  default: {
    platform: "default",
    minTags: 3,
    maxTags: 7,
    recommendedTags: 6,
    broadRatio: 0.33,      // 2 tags
    communityRatio: 0.50,  // 3 tags
    nicheRatio: 0.17,      // 1-2 tags
  },
};

// ---------------------------------------------------------------------------
// Index Construction for O(1) Lookups (< 10ms SLA)
// ---------------------------------------------------------------------------

const TAG_INDEX = new Map<string, HashtagEntry>();
const DOMAIN_TIER_INDEX = new Map<
  HashtagDomain,
  { broad: HashtagEntry[]; community: HashtagEntry[]; niche: HashtagEntry[] }
>();
const KEYWORD_INDEX = new Map<string, HashtagEntry[]>();

for (const entry of TAXONOMY_DATA) {
  const normalizedTag = entry.tag.toLowerCase();
  TAG_INDEX.set(normalizedTag, entry);

  let domainBucket = DOMAIN_TIER_INDEX.get(entry.domain);
  if (!domainBucket) {
    domainBucket = { broad: [], community: [], niche: [] };
    DOMAIN_TIER_INDEX.set(entry.domain, domainBucket);
  }

  if (entry.tier === "BROAD") {
    domainBucket.broad.push(entry);
  } else if (entry.tier === "COMMUNITY") {
    domainBucket.community.push(entry);
  } else {
    domainBucket.niche.push(entry);
  }

  for (const kw of entry.keywords) {
    const k = kw.toLowerCase().trim();
    if (!k) continue;
    let entries = KEYWORD_INDEX.get(k);
    if (!entries) {
      entries = [];
      KEYWORD_INDEX.set(k, entries);
    }
    entries.push(entry);
  }
}

// ---------------------------------------------------------------------------
// Sanitization & Classification
// ---------------------------------------------------------------------------

/**
 * Sanitizes a raw input string into a valid hashtag.
 * Strips whitespace, quotes, forbidden characters, emojis, and ensures `#` prefix.
 * Complies with Unicode letter, mark, digit, and underscore rules.
 */
export function sanitizeHashtag(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Remove leading # if present for cleaning
  let body = trimmed.replace(/^#+/, "");

  // Remove internal spaces and forbidden punctuation
  body = body.replace(/[\s\.,\/#!$%\^&\*;:{}=\-`~()?"'<>@\[\]\\|]/g, "");

  // Keep only unicode letters, marks, digits, and underscores
  // Regex matches unicode property escapes \p{L}, \p{M}, \p{N}, _
  body = body.replace(/[^\p{L}\p{M}\p{N}_]/gu, "");

  if (!body) return null;
  return `#${body}`;
}

/**
 * Classifies an arbitrary hashtag into BROAD, COMMUNITY, or NICHE tier.
 * Uses exact taxonomy knowledge when available, with intelligent heuristic fallbacks.
 */
export function classifyTagTier(tag: string): HashtagTier {
  const clean = sanitizeHashtag(tag);
  if (!clean) return "COMMUNITY";

  const exact = TAG_INDEX.get(clean.toLowerCase());
  if (exact) {
    return exact.tier;
  }

  const length = clean.length - 1; // exclude #
  const lower = clean.toLowerCase();

  // Common high-volume indicators
  if (
    length <= 6 ||
    lower.includes("tech") ||
    lower.includes("ai") ||
    lower.includes("business") ||
    lower.includes("gym") ||
    lower.includes("food") ||
    lower.includes("travel") ||
    lower.includes("money")
  ) {
    return "BROAD";
  }

  // Very specific compounds or tool names
  if (
    length >= 16 ||
    lower.includes("database") ||
    lower.includes("pipeline") ||
    lower.includes("routine") ||
    lower.includes("strategy") ||
    lower.includes("framework") ||
    lower.includes("architecture")
  ) {
    return "NICHE";
  }

  return "COMMUNITY";
}

// ---------------------------------------------------------------------------
// Domain & Topic Extraction
// ---------------------------------------------------------------------------

const DOMAIN_TRIGGERS: Record<HashtagDomain, readonly string[]> = {
  ai: ["ai", "artificial intelligence", "machine learning", "deep learning", "llm", "llms", "gpt", "rag", "vector", "prompt", "openai", "claude", "gemini", "neural"],
  tech: ["tech", "coding", "software", "developer", "programming", "javascript", "python", "typescript", "react", "nextjs", "devops", "cloud", "aws", "docker"],
  business: ["business", "startup", "founder", "saas", "entrepreneur", "revenue", "sales", "bootstrapping", "venture", "funding", "pricing", "growth"],
  finance: ["finance", "money", "investing", "stocks", "real estate", "passive income", "wealth", "etf", "dividend", "budget", "portfolio", "roi"],
  marketing: ["marketing", "seo", "branding", "copywriting", "advertising", "conversion", "email marketing", "social media", "funnel", "lead generation"],
  creator_economy: ["creator", "youtube", "video editing", "podcast", "shorts", "reels", "tiktok", "filmmaking", "thumbnail", "premiere", "broll", "hook"],
  productivity: ["productivity", "habits", "notion", "discipline", "time management", "morning routine", "focus", "deep work", "organization", "goals"],
  fitness: ["fitness", "gym", "workout", "muscle", "nutrition", "calories", "protein", "bodybuilding", "hypertrophy", "bench press", "squat", "calisthenics"],
  gaming: ["gaming", "gamer", "esports", "twitch", "gameplay", "fps", "rpg", "steam", "playstation", "xbox", "pc gaming", "clutch", "highlights"],
  crypto: ["crypto", "bitcoin", "ethereum", "web3", "blockchain", "defi", "solana", "altcoin", "trading", "wallet", "nft", "token"],
  comedy: ["comedy", "funny", "humor", "joke", "jokes", "skit", "parody", "standup", "relatable", "prank", "hilarious", "laugh"],
  education: ["education", "science", "history", "psychology", "learning", "study", "facts", "books", "philosophy", "curiosity", "school"],
  food: ["food", "cooking", "recipe", "chef", "foodie", "baking", "dinner", "delicious", "meal", "kitchen", "street food", "taste"],
  travel: ["travel", "wanderlust", "adventure", "vacation", "trip", "backpacking", "destinations", "mountains", "beach", "hotel", "explore"],
  fashion: ["fashion", "style", "ootd", "outfit", "streetwear", "clothing", "vintage", "sneakers", "aesthetic", "wardrobe", "thrift"],
};

/**
 * Detects the most relevant domain from transcript text and clip title.
 */
export function detectDomain(text: string, title: string = ""): HashtagDomain {
  const combined = `${title} ${text}`.toLowerCase();
  let bestDomain: HashtagDomain = "tech";
  let highestScore = -1;

  for (const [domain, triggers] of Object.entries(DOMAIN_TRIGGERS) as [HashtagDomain, readonly string[]][]) {
    let score = 0;
    for (const trigger of triggers) {
      if (combined.includes(trigger)) {
        score += trigger.includes(" ") ? 3 : 1;
      }
    }
    if (score > highestScore) {
      highestScore = score;
      bestDomain = domain;
    }
  }

  return bestDomain;
}

// ---------------------------------------------------------------------------
// 3-Tier Pyramid Assembler
// ---------------------------------------------------------------------------

export interface RecommendOptions {
  readonly text: string;
  readonly title?: string;
  readonly platform?: DestinationPlatform;
  readonly customTags?: readonly string[];
  readonly limit?: number;
  readonly domain?: HashtagDomain;
}

/**
 * Constructs a mathematically balanced 3-Tier Pyramid Hashtag Bundle.
 *
 * Tier Structure:
 *   - Tier 1: Broad Category (1–2 tags, 10M+ posts)
 *   - Tier 2: Community Subculture (3–4 tags, 100k–1M posts)
 *   - Tier 3: Hyper-Niche Subject (2–3 tags, < 100k posts)
 *
 * Automatically adapts tag quotas to the destination platform.
 */
export function recommendPyramidBundle(options: RecommendOptions): PyramidBundle {
  const platform = options.platform ?? "default";
  const rule = PLATFORM_HASHTAG_RULES[platform] ?? PLATFORM_HASHTAG_RULES.default;
  const domain = options.domain ?? detectDomain(options.text, options.title ?? "");
  const domainBucket = DOMAIN_TIER_INDEX.get(domain) ?? DOMAIN_TIER_INDEX.get("tech")!;

  const maxTotal = options.limit ?? rule.maxTags;
  const combinedText = `${options.title ?? ""} ${options.text}`.toLowerCase();

  // Banned keywords check
  const isBanned = (tag: string): boolean => {
    if (!rule.bannedKeywords) return false;
    const lower = tag.toLowerCase();
    return rule.bannedKeywords.some((b) => lower.includes(b.toLowerCase()));
  };

  // Rank entries in a tier by keyword presence in transcript/title
  const rankTierEntries = (entries: readonly HashtagEntry[]): HashtagEntry[] => {
    return [...entries].sort((a, b) => {
      const aMatches = a.keywords.filter((kw) => combinedText.includes(kw.toLowerCase())).length;
      const bMatches = b.keywords.filter((kw) => combinedText.includes(kw.toLowerCase())).length;
      if (aMatches !== bMatches) return bMatches - aMatches;
      return b.postCountTier - a.postCountTier;
    });
  };

  const rankedBroad = rankTierEntries(domainBucket.broad);
  const rankedCommunity = rankTierEntries(domainBucket.community);
  const rankedNiche = rankTierEntries(domainBucket.niche);

  // Determine quotas based on platform limits
  let broadQuota: number;
  let communityQuota: number;
  let nicheQuota: number;

  switch (platform) {
    case "youtube":
      broadQuota = 1;
      communityQuota = 2;
      nicheQuota = 1; // Total: 4 tags (under max 5)
      break;
    case "instagram":
      broadQuota = 2;
      communityQuota = 3;
      nicheQuota = 2; // Total: 7 tags (under max 8)
      break;
    case "tiktok":
      broadQuota = 1;
      communityQuota = 3;
      nicheQuota = 1; // Total: 5 tags (under max 6)
      break;
    case "linkedin":
      broadQuota = 1;
      communityQuota = 2;
      nicheQuota = 0; // Total: 3 tags (max 3, professional community)
      break;
    case "x":
      broadQuota = 1;
      communityQuota = 1;
      nicheQuota = 0; // Total: 2 tags (max 3)
      break;
    default:
      broadQuota = 2;
      communityQuota = 3;
      nicheQuota = 2; // Total: 7 tags
      break;
  }

  const selectedBroad: string[] = [];
  const selectedCommunity: string[] = [];
  const selectedNiche: string[] = [];
  const seenTags = new Set<string>();

  // Incorporate valid user custom tags first if provided
  if (options.customTags && options.customTags.length > 0) {
    for (const raw of options.customTags) {
      const clean = sanitizeHashtag(raw);
      if (!clean || seenTags.has(clean.toLowerCase()) || isBanned(clean)) continue;
      seenTags.add(clean.toLowerCase());
      const tier = classifyTagTier(clean);
      if (tier === "BROAD" && selectedBroad.length < broadQuota) {
        selectedBroad.push(clean);
      } else if (tier === "COMMUNITY" && selectedCommunity.length < communityQuota) {
        selectedCommunity.push(clean);
      } else if (tier === "NICHE" && selectedNiche.length < nicheQuota) {
        selectedNiche.push(clean);
      }
    }
  }

  // Fill Broad Tier
  for (const entry of rankedBroad) {
    if (selectedBroad.length >= broadQuota) break;
    const clean = entry.tag;
    if (seenTags.has(clean.toLowerCase()) || isBanned(clean)) continue;
    seenTags.add(clean.toLowerCase());
    selectedBroad.push(clean);
  }

  // Fill Community Tier
  for (const entry of rankedCommunity) {
    if (selectedCommunity.length >= communityQuota) break;
    const clean = entry.tag;
    if (seenTags.has(clean.toLowerCase()) || isBanned(clean)) continue;
    seenTags.add(clean.toLowerCase());
    selectedCommunity.push(clean);
  }

  // Fill Niche Tier
  for (const entry of rankedNiche) {
    if (selectedNiche.length >= nicheQuota) break;
    const clean = entry.tag;
    if (seenTags.has(clean.toLowerCase()) || isBanned(clean)) continue;
    seenTags.add(clean.toLowerCase());
    selectedNiche.push(clean);
  }

  // Assemble full pyramid list: Broad -> Community -> Niche
  const allTags = [...selectedBroad, ...selectedCommunity, ...selectedNiche].slice(0, maxTotal);

  return {
    broad: selectedBroad,
    community: selectedCommunity,
    niche: selectedNiche,
    all: allTags,
    formatted: allTags.join(" "),
    domain,
    platform,
  };
}

/**
 * Returns all taxonomy entries for a specific domain.
 */
export function getDomainTaxonomy(domain: HashtagDomain) {
  return DOMAIN_TIER_INDEX.get(domain) ?? DOMAIN_TIER_INDEX.get("tech")!;
}

/**
 * Returns total count of indexed hashtags.
 */
export function getTaxonomySize(): number {
  return TAXONOMY_DATA.length;
}
