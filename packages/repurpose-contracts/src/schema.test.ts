import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ClipCandidateSchema,
  ClipCopySchema,
  ClipLengthPresetSchema,
  ClipVariantViewSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  DURATION_BINS,
  DiagnosticItemSchema,
  DurationBinSchema,
  DurationCustomRangeSchema,
  ManualCandidateRequestSchema,
  PlatformSocialPackSchema,
  RepurposeClipViewSchema,
  RunConfigSchema,
  SAFE_ERROR_CODES,
  StageProgressSchema,
  ViralityDiagnosticSchema,
  buildPlatformSocialPack,
  resolveDurationBin,
  validateDurationRange,
} from "./schema.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CLIP_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const VARIANT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

function fixture(name: string): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture names are local literals, not user-controlled paths
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", name), "utf8")) as unknown;
}

describe("repurpose@1 fixture contracts", () => {
  it("accepts documented configuration, candidate and URL-create examples", () => {
    expect(RunConfigSchema.safeParse(fixture("run-config.v1.json")).success).toBe(true);
    expect(ClipCandidateSchema.safeParse(fixture("candidate.v1.json")).success).toBe(true);
    expect(CreateRunRequestSchema.safeParse(fixture("create-run-request.v1.json")).success).toBe(
      true,
    );
    expect(CreateRunResponseSchema.safeParse(fixture("create-run-response.v1.json")).success).toBe(
      true,
    );
    expect(
      CreateRunResponseSchema.safeParse(fixture("create-upload-response.v1.json")).success,
    ).toBe(true);
    expect(
      ManualCandidateRequestSchema.safeParse(fixture("manual-candidate-request.v1.json")).success,
    ).toBe(true);
    expect(RepurposeClipViewSchema.safeParse(fixture("clip-view.v1.json")).success).toBe(true);
  });

  it("takes a candidate's track-record reason, and no label it does not know", () => {
    const candidate = fixture("candidate.v1.json") as Record<string, unknown>;
    const reason = (label: string) => ({
      ...candidate,
      reasons: [{ label, explanation: "Like your clip about SIPs that got 12k views." }],
    });
    expect(ClipCandidateSchema.safeParse(reason("track_record")).success).toBe(true);
    expect(ClipCandidateSchema.safeParse(reason("viral")).success).toBe(false);
  });

  it("freezes a steered discovery (topic, length, skips) and still refuses nonsense in it", () => {
    // Steering (2026-09-29): what the create request's `discovery` carries is
    // what the run config freezes, so every preset the request accepts must be
    // one the config accepts too.
    const config = RunConfigSchema.parse(fixture("run-config.v1.json"));
    for (const clipLength of ClipLengthPresetSchema.options) {
      const steered = {
        ...config,
        discovery: {
          ...config.discovery,
          topic: "money habits, startup failures",
          clipLength,
          skipIntroMs: 120_000,
          skipOutroMs: 0,
        },
      };
      const parsed = RunConfigSchema.safeParse(steered);
      expect(parsed.success ? [] : parsed.error.issues, clipLength).toEqual([]);
    }
    for (const bad of [
      { topic: "x" },
      { clipLength: "epic" },
      { skipIntroMs: -1 },
      { skipOutroMs: 1_800_001 },
    ]) {
      expect(
        RunConfigSchema.safeParse({ ...config, discovery: { ...config.discovery, ...bad } })
          .success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("rejects version drift, unknown enums and extra setup fields", () => {
    const config = RunConfigSchema.parse(fixture("run-config.v1.json"));
    expect(RunConfigSchema.safeParse({ ...config, schemaVersion: 2 }).success).toBe(false);
    expect(
      RunConfigSchema.safeParse({ ...config, formats: [{ ...config.formats[0], aspect: "3:2" }] })
        .success,
    ).toBe(false);
    expect(RunConfigSchema.safeParse({ ...config, surprise: true }).success).toBe(false);
    expect(
      RunConfigSchema.safeParse({ ...config, formats: [config.formats[0], config.formats[0]] })
        .success,
    ).toBe(false);
  });

  it("rejects inverted or excessive bounds and missing AI score evidence", () => {
    const candidate = ClipCandidateSchema.parse(fixture("candidate.v1.json"));
    expect(ClipCandidateSchema.safeParse({ ...candidate, endMs: candidate.startMs }).success).toBe(
      false,
    );
    expect(
      ClipCandidateSchema.safeParse({ ...candidate, endMs: candidate.startMs + 2_999 }).success,
    ).toBe(false);
    expect(
      ClipCandidateSchema.safeParse({ ...candidate, endMs: candidate.startMs + 180_001 }).success,
    ).toBe(false);
    expect(ClipCandidateSchema.safeParse({ ...candidate, scoreBreakdown: null }).success).toBe(
      false,
    );
    expect(ClipCandidateSchema.safeParse({ ...candidate, potentialScore: 101 }).success).toBe(
      false,
    );
    expect(
      ClipCandidateSchema.safeParse({
        ...candidate,
        signals: { ...candidate.signals, faceId: "person-1" },
      }).success,
    ).toBe(false);
  });

  it("requires rights attestation, HTTPS and bounded upload metadata", () => {
    const request = CreateRunRequestSchema.parse(fixture("create-run-request.v1.json"));
    expect(
      CreateRunRequestSchema.safeParse({
        ...request,
        source: { ...request.source, rightsAttested: false },
      }).success,
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        ...request,
        setup: {
          ...request.setup,
          discovery: { ...request.setup.discovery, mode: "manual", requestedCandidates: 5 },
        },
      }).success,
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        ...request,
        source: { ...request.source, url: "http://example.com/a.mp4" },
      }).success,
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        ...request,
        source: {
          kind: "upload",
          filename: "clip.mp4",
          mime: "video/mp4",
          sizeBytes: 0,
          rightsAttested: true,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps candidate manual mode free of AI evidence", () => {
    const candidate = ClipCandidateSchema.parse(fixture("candidate.v1.json"));
    expect(
      ClipCandidateSchema.safeParse({
        ...candidate,
        source: "manual",
        rank: null,
        potentialScore: null,
        scoreBreakdown: null,
      }).success,
    ).toBe(true);
  });

  it("rejects out-of-range manual candidate requests and inverted materialized clips", () => {
    const request = ManualCandidateRequestSchema.parse(fixture("manual-candidate-request.v1.json"));
    const clip = RepurposeClipViewSchema.parse(fixture("clip-view.v1.json"));
    expect(
      ManualCandidateRequestSchema.safeParse({ ...request, endMs: request.startMs + 2_999 })
        .success,
    ).toBe(false);
    expect(
      RepurposeClipViewSchema.safeParse({ ...clip, sourceEndMs: clip.sourceStartMs }).success,
    ).toBe(false);
  });

  it("allows only stable, safe stage errors and prevents errors on successful stages", () => {
    const base = {
      schemaVersion: 1,
      runId: RUN_ID,
      stage: "getting_video",
      state: "failed",
      percent: 15,
      safeError: {
        code: SAFE_ERROR_CODES[2],
        message: "We could not get this video.",
        retryable: true,
      },
      updatedAt: "2026-09-15T00:00:00.000Z",
    };
    expect(StageProgressSchema.safeParse(base).success).toBe(true);
    expect(StageProgressSchema.safeParse({ ...base, safeError: null }).success).toBe(false);
    expect(StageProgressSchema.safeParse({ ...base, state: "complete" }).success).toBe(false);
    expect(
      StageProgressSchema.safeParse({
        ...base,
        safeError: { ...base.safeError, code: "provider/raw_exception" },
      }).success,
    ).toBe(false);
  });

  it("accepts an editor deep link and rejects an external link", () => {
    const view = {
      schemaVersion: 1,
      runId: RUN_ID,
      clipId: CLIP_ID,
      variantId: VARIANT_ID,
      projectId: PROJECT_ID,
      aspect: "9:16",
      status: "ready",
      editorHref: `/p/${PROJECT_ID}?returnTo=/repurpose/${RUN_ID}&variant=${VARIANT_ID}`,
      editFingerprint: "a".repeat(64),
      latestExportId: null,
      approvedAt: null,
    };
    expect(ClipVariantViewSchema.safeParse(view).success).toBe(true);
    expect(
      ClipVariantViewSchema.safeParse({ ...view, editorHref: "https://example.com/editor" })
        .success,
    ).toBe(false);
    expect(
      ClipVariantViewSchema.safeParse({
        ...view,
        editorHref: `/p/${PROJECT_ID}?returnTo=https://evil.example&variant=${VARIANT_ID}`,
      }).success,
    ).toBe(false);
  });

  it("validates ViralityDiagnostic schema and enforces valid categories and sentiments", () => {
    const valid = {
      overallSummary: "Strong contrarian hook in first 2.5s with actionable payoff.",
      items: [
        {
          category: "HOOK",
          label: "Contrarian Opening",
          detail: "Challenges standard assumptions immediately.",
          sentiment: "POSITIVE",
        },
        {
          category: "RETENTION",
          label: "High-Value Conclusion",
          detail: "Leaves viewer with an actionable takeaway.",
          sentiment: "POSITIVE",
        },
      ],
      creatorTip: "Add a punch-in camera zoom on second 03.",
    };
    expect(ViralityDiagnosticSchema.safeParse(valid).success).toBe(true);
    expect(
      DiagnosticItemSchema.safeParse({
        category: "INVALID",
        label: "Bad Category",
        detail: "Should fail validation",
        sentiment: "POSITIVE",
      }).success,
    ).toBe(false);
    expect(
      DiagnosticItemSchema.safeParse({
        category: "HOOK",
        label: "Bad Sentiment",
        detail: "Should fail validation",
        sentiment: "UNKNOWN",
      }).success,
    ).toBe(false);
  });

  it("accepts a candidate with virality diagnostic rationale attached", () => {
    const candidate = fixture("candidate.v1.json") as Record<string, unknown>;
    const withDiag = {
      ...candidate,
      diagnostic: {
        overallSummary: "High-retention reel candidate with strong opening curiosity gap.",
        items: [
          {
            category: "HOOK",
            label: "Audience Inquiry",
            detail: "Opens with a direct question that arrests attention.",
            sentiment: "POSITIVE",
          },
          {
            category: "FLOW",
            label: "Seamless Cadence",
            detail: "Unbroken conversational rhythm with zero dead air.",
            sentiment: "POSITIVE",
          },
        ],
        creatorTip: "Cut 0.5s pause at start to jump straight into speech.",
      },
    };
    expect(ClipCandidateSchema.safeParse(withDiag).success).toBe(true);
  });

  it("validates DurationBinSchema, DURATION_BINS, and custom duration ranges", () => {
    expect(DURATION_BINS.UNDER_30).toEqual({ minSec: 15, maxSec: 30, label: "< 30s (Rapid Loops)" });
    expect(DURATION_BINS.BETWEEN_30_60).toEqual({
      minSec: 30,
      maxSec: 60,
      label: "30s–60s (Shorts & Reels)",
    });
    expect(DURATION_BINS.BETWEEN_60_90).toEqual({
      minSec: 60,
      maxSec: 90,
      label: "60s–90s (TikTok Monetization)",
    });
    expect(DURATION_BINS.BETWEEN_90_180).toEqual({
      minSec: 90,
      maxSec: 180,
      label: "90s–3m (Deep Dives & LinkedIn)",
    });
    expect(DURATION_BINS.AUTO).toEqual({ minSec: 20, maxSec: 90, label: "AI Recommended" });

    for (const bin of ["UNDER_30", "BETWEEN_30_60", "BETWEEN_60_90", "BETWEEN_90_180", "AUTO", "60_90"]) {
      expect(DurationBinSchema.safeParse(bin).success).toBe(true);
    }
    expect(DurationBinSchema.safeParse("INVALID_BIN").success).toBe(false);

    expect(resolveDurationBin("BETWEEN_60_90")).toEqual({
      key: "BETWEEN_60_90",
      minSec: 60,
      maxSec: 90,
      minDurationMs: 60_000,
      maxDurationMs: 90_000,
      label: "60s–90s (TikTok Monetization)",
    });
    expect(resolveDurationBin("60_90")?.minDurationMs).toBe(60_000);
    expect(resolveDurationBin("UNDER_30")?.maxDurationMs).toBe(30_000);
    expect(resolveDurationBin("BETWEEN_90_180")?.maxDurationMs).toBe(180_000);
    expect(resolveDurationBin("AUTO")?.minDurationMs).toBe(20_000);
    expect(resolveDurationBin("unknown")).toBeNull();

    // Validate 0 < minDurationSec < maxDurationSec <= 300
    expect(DurationCustomRangeSchema.safeParse({ minDurationSec: 45, maxDurationSec: 75 }).success).toBe(true);
    expect(DurationCustomRangeSchema.safeParse({ minDurationSec: 1, maxDurationSec: 300 }).success).toBe(true);
    expect(DurationCustomRangeSchema.safeParse({ minDurationSec: 0, maxDurationSec: 60 }).success).toBe(false);
    expect(DurationCustomRangeSchema.safeParse({ minDurationSec: 60, maxDurationSec: 60 }).success).toBe(false);
    expect(DurationCustomRangeSchema.safeParse({ minDurationSec: 90, maxDurationSec: 60 }).success).toBe(false);
    expect(DurationCustomRangeSchema.safeParse({ minDurationSec: 30, maxDurationSec: 301 }).success).toBe(false);

    expect(validateDurationRange(45, 75)).toBe(true);
    expect(validateDurationRange(0, 60)).toBe(false);
    expect(validateDurationRange(75, 45)).toBe(false);
    expect(validateDurationRange(30, 301)).toBe(false);
  });

  it("validates PlatformSocialPackSchema character limits and compliance", () => {
    const validPack = {
      youtube: {
        title: "How We Scaled to $1M ARR #Shorts",
        description: "Full breakdown of our bootstrapped SaaS journey.",
        tags: ["Shorts", "SaaS", "Startups"],
      },
      instagram: {
        caption: "Stop doing this in 2026 🛑\n\nSave this breakdown.",
        callToAction: "Save this reel for later",
        hashtags: ["#startups", "#saas"],
      },
      tiktok: {
        caption: "the brutal truth about startups #fyp #techtok",
        hashtags: ["#fyp", "#techtok"],
      },
      linkedin: {
        postText: "A critical shift in B2B SaaS architecture:\n\n1. Problem\n2. Solution",
        hashtags: ["#leadership", "#technology"],
      },
      twitter: {
        tweetText: "Most founders get customer acquisition wrong. Here is why:",
      },
    };

    expect(PlatformSocialPackSchema.safeParse(validPack).success).toBe(true);

    // YouTube title must be <= 70 chars
    const tooLongYt = {
      ...validPack,
      youtube: { ...validPack.youtube, title: "A".repeat(71) },
    };
    expect(PlatformSocialPackSchema.safeParse(tooLongYt).success).toBe(false);

    // Twitter must be <= 280 chars
    const tooLongTweet = {
      ...validPack,
      twitter: { tweetText: "A".repeat(281) },
    };
    expect(PlatformSocialPackSchema.safeParse(tooLongTweet).success).toBe(false);

    // ClipCopySchema accepts socialPack
    const copyWithPack = {
      summary: "A great clip",
      hook: "Watch this",
      cta: "Follow for more",
      hashtags: ["#tech"],
      locale: "en",
      socialPack: validPack,
    };
    expect(ClipCopySchema.safeParse(copyWithPack).success).toBe(true);

    // buildPlatformSocialPack builds valid PlatformSocialPack
    const derived = buildPlatformSocialPack({
      title: "Very Long Title That Would Normally Exceed YouTube Character Limits For Shorts Title",
      hook: "Watch this immediately",
      summary: "Summary of the video clip",
      description: "Full description of the clip",
      cta: "Follow for more updates",
      hashtags: ["#shorts", "#tech", "#ai"],
    });

    expect(PlatformSocialPackSchema.safeParse(derived).success).toBe(true);
    expect(derived.youtube.title.length).toBeLessThanOrEqual(70);
    expect(derived.youtube.title.toLowerCase()).toContain("#shorts");
    expect(derived.twitter.tweetText.length).toBeLessThanOrEqual(280);
    expect(derived.instagram.hashtags).toContain("#tech");
  });
});
