import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTagTier,
  detectDomain,
  getDomainTaxonomy,
  getTaxonomySize,
  PLATFORM_HASHTAG_RULES,
  recommendPyramidBundle,
  sanitizeHashtag,
  TAXONOMY_DATA,
} from "./index.js";
import type { HashtagDomain } from "./types.js";

const ALL_DOMAINS: HashtagDomain[] = [
  "ai",
  "tech",
  "business",
  "finance",
  "marketing",
  "creator_economy",
  "productivity",
  "fitness",
  "gaming",
  "crypto",
  "comedy",
  "education",
  "food",
  "travel",
  "fashion",
];

test("taxonomy contains at least 1,500 curated hashtags across 15 domains", () => {
  const size = getTaxonomySize();
  assert.ok(size >= 1500, `Expected at least 1500 entries, received ${size}`);
  assert.equal(TAXONOMY_DATA.length, size);
});

test("all 15 domains have balanced BROAD, COMMUNITY, and NICHE tiers", () => {
  for (const domain of ALL_DOMAINS) {
    const bucket = getDomainTaxonomy(domain);
    assert.ok(bucket.broad.length >= 5, `${domain} should have at least 5 broad tags`);
    assert.ok(bucket.community.length >= 10, `${domain} should have at least 10 community tags`);
    assert.ok(bucket.niche.length >= 10, `${domain} should have at least 10 niche tags`);

    // Verify all entries have valid '#' prefixes and non-empty keywords
    for (const entry of [...bucket.broad, ...bucket.community, ...bucket.niche]) {
      assert.ok(entry.tag.startsWith("#"), `Tag ${entry.tag} must start with '#'`);
      assert.equal(entry.domain, domain);
      assert.ok(entry.postCountTier > 0, `Tag ${entry.tag} must have a positive postCountTier`);
      assert.ok(entry.keywords.length > 0, `Tag ${entry.tag} must have triggering keywords`);
    }
  }
});

test("sanitizes hashtags correctly with strict punctuation/emoji stripping and Unicode preservation", () => {
  assert.equal(sanitizeHashtag("ai productivity"), "#aiproductivity");
  assert.equal(sanitizeHashtag("#TechTrends!"), "#TechTrends");
  assert.equal(sanitizeHashtag("  #Startup_Growth101  "), "#Startup_Growth101");
  assert.equal(sanitizeHashtag("crypto🚀moon"), "#cryptomoon");
  assert.equal(sanitizeHashtag("#हिंदी_वीडियो"), "#हिंदी_वीडियो");
  assert.equal(sanitizeHashtag(""), null);
  assert.equal(sanitizeHashtag("###"), null);
  assert.equal(sanitizeHashtag("   !@#$%   "), null);
});

test("accurately classifies tag tiers (BROAD vs COMMUNITY vs NICHE)", () => {
  assert.equal(classifyTagTier("#ai"), "BROAD");
  assert.equal(classifyTagTier("#technology"), "BROAD");
  assert.equal(classifyTagTier("#aiproductivity"), "COMMUNITY");
  assert.equal(classifyTagTier("#saasgrowth"), "COMMUNITY");
  assert.equal(classifyTagTier("#vectordatabases"), "NICHE");
  assert.equal(classifyTagTier("#retrievalaugmentedgeneration"), "NICHE");
});

test("detects domain accurately from transcript and title context", () => {
  assert.equal(
    detectDomain(
      "In this clip we discuss building a RAG pipeline with vector databases and local LLMs.",
      "How to build AI apps"
    ),
    "ai"
  );

  assert.equal(
    detectDomain(
      "How we scaled our B2B SaaS startup to 1 million ARR with zero venture capital funding.",
      "Bootstrapping SaaS"
    ),
    "business"
  );

  assert.equal(
    detectDomain(
      "Here is why progressive overload and hypertrophy are essential for building muscle in the gym.",
      "Leg day workout routine"
    ),
    "fitness"
  );
});

test("assembles 3-tier pyramid bundle respecting platform rules and quotas", () => {
  const sampleTranscript =
    "We migrated our entire vector search architecture to Qdrant and local embeddings for our RAG pipeline, cutting LLM token costs by 80%.";
  const sampleTitle = "Cutting AI Infrastructure Costs with Vector Search";

  // 1. YouTube Shorts (max 5 tags, target 3-5)
  const ytBundle = recommendPyramidBundle({
    text: sampleTranscript,
    title: sampleTitle,
    platform: "youtube",
  });
  assert.ok(ytBundle.all.length >= 3 && ytBundle.all.length <= 5, "YouTube bundle within 3-5 tags");
  assert.ok(ytBundle.broad.length >= 1, "Should have Tier 1 Broad tag");
  assert.ok(ytBundle.community.length >= 1, "Should have Tier 2 Community tag");
  assert.ok(ytBundle.niche.length >= 1, "Should have Tier 3 Niche tag");
  assert.ok(ytBundle.formatted.includes("#"), "Formatted string should contain hashtags");

  // 2. Instagram Reels (max 8 tags, target 5-8)
  const igBundle = recommendPyramidBundle({
    text: sampleTranscript,
    title: sampleTitle,
    platform: "instagram",
  });
  assert.ok(igBundle.all.length >= 5 && igBundle.all.length <= 8, "Instagram bundle within 5-8 tags");
  assert.equal(igBundle.broad.length, 2, "Instagram has 2 broad tags");
  assert.ok(igBundle.community.length >= 2, "Instagram has community tags");
  assert.ok(igBundle.niche.length >= 1, "Instagram has niche tags");

  // 3. TikTok (max 6 tags, target 3-6)
  const ttBundle = recommendPyramidBundle({
    text: sampleTranscript,
    title: sampleTitle,
    platform: "tiktok",
  });
  assert.ok(ttBundle.all.length >= 3 && ttBundle.all.length <= 6, "TikTok bundle within 3-6 tags");

  // 4. LinkedIn (max 3 tags, professional community tags, no #fyp/#viral)
  const liBundle = recommendPyramidBundle({
    text: sampleTranscript,
    title: sampleTitle,
    platform: "linkedin",
    customTags: ["#fyp", "#viral", "#innovation"],
  });
  assert.ok(liBundle.all.length <= 3, "LinkedIn bundle caps at 3 tags");
  assert.ok(!liBundle.all.some((t) => t.toLowerCase().includes("fyp")), "Bans #fyp");
  assert.ok(!liBundle.all.some((t) => t.toLowerCase().includes("viral")), "Bans #viral");

  // 5. X / Twitter (max 3 tags, target 1-3)
  const xBundle = recommendPyramidBundle({
    text: sampleTranscript,
    title: sampleTitle,
    platform: "x",
  });
  assert.ok(xBundle.all.length >= 1 && xBundle.all.length <= 3, "X bundle within 1-3 tags");
});

test("guarantees latency SLA under 50ms (SLA target is <= 300ms)", () => {
  const start = performance.now();
  for (let i = 0; i < 50; i++) {
    recommendPyramidBundle({
      text: "Machine learning transformers and prompt engineering with LangChain and vector databases",
      title: "Building modern AI workflows",
      platform: "instagram",
    });
  }
  const duration = performance.now() - start;
  const avgDuration = duration / 50;
  assert.ok(avgDuration < 50, `Average generation latency ${avgDuration.toFixed(2)}ms exceeds 50ms SLA`);
});
