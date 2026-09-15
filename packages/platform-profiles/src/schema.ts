import { z } from "zod";

import { AspectSchema } from "@montaj/repurpose-contracts";

export const PLATFORM_PROFILE_SCHEMA_VERSION = 1 as const;
export const TEST_PROFILE_IDS = [
  "instagram-reel",
  "youtube-short",
  "linkedin-video",
  "tiktok-video",
] as const;
export const TestProfileIdSchema = z.enum(TEST_PROFILE_IDS);
export const PUBLISH_MODES = ["direct", "schedule", "mobile_handoff", "download_only"] as const;
export const PublishModeSchema = z.enum(PUBLISH_MODES);

const EvidenceRefSchema = z.string().trim().min(1).max(200);
const SourceUrlSchema = z.url().refine((url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname === "www.postman.com") return parsed.pathname.startsWith("/meta/instagram/");
  return [
    "developers.facebook.com",
    "developers.google.com",
    "support.google.com",
    "learn.microsoft.com",
    "developers.tiktok.com",
  ].includes(parsed.hostname);
}, "Documentation reference must point to an official platform source.");

export const ProfileSourceSchema = z.strictObject({
  url: SourceUrlSchema,
  sourceType: z.enum(["official_docs", "official_help", "official_owner_collection"]),
  checkedAt: z.iso.date(),
});

/** A conservative Aksharo export choice, not the provider's maximum allowance. */
export const PreparationBoundsSchema = z
  .strictObject({
    aspect: AspectSchema,
    width: z.int().positive().max(4096),
    height: z.int().positive().max(4096),
    frameRate: z.int().min(24).max(60),
    container: z.literal("mp4"),
    videoCodec: z.literal("h264"),
    audioCodec: z.literal("aac"),
    minDurationMs: z.int().min(3_000).max(180_000),
    maxDurationMs: z.int().min(3_000).max(180_000),
    maxBytes: z.int().positive().max(10_000_000_000),
  })
  .superRefine((value, context) => {
    if (value.minDurationMs > value.maxDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["maxDurationMs"],
        message: "Preparation max duration is below min.",
      });
    }
    const ratio = { "9:16": 9 / 16, "4:5": 4 / 5, "1:1": 1, "16:9": 16 / 9 }[value.aspect];
    if (Math.abs(value.width / value.height - ratio) > 0.01) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "Preparation dimensions do not match aspect.",
      });
    }
  });

export const ActivationProofSchema = z.strictObject({
  credentialOwnerRef: EvidenceRefSchema,
  scopesEvidenceRef: EvidenceRefSchema,
  appReviewEvidenceRef: EvidenceRefSchema,
  testAccountEvidenceRef: EvidenceRefSchema,
  smokeEvidenceRef: EvidenceRefSchema,
  lastVerifiedAt: z.iso.datetime(),
});

export const TestProfileSchema = z
  .strictObject({
    schemaVersion: z.literal(PLATFORM_PROFILE_SCHEMA_VERSION),
    profileVersion: z.string().trim().min(1).max(100),
    id: TestProfileIdSchema,
    provider: z.enum(["meta", "youtube", "linkedin", "tiktok"]),
    surface: z.string().trim().min(1).max(100),
    status: z.enum(["test_only", "approved_staging"]),
    enabled: z.boolean(),
    desiredModes: z.array(PublishModeSchema).min(1).max(4),
    enabledModes: z.array(PublishModeSchema).min(1).max(4),
    fallback: z.literal("download_only"),
    featureFlags: z
      .array(z.enum(["repurpose_flow", "publishing_postiz", "publishing_tiktok"]))
      .min(1)
      .max(3),
    needsLiveAccountCapabilityCheck: z.literal(true),
    preparation: PreparationBoundsSchema,
    sources: z.array(ProfileSourceSchema).min(1).max(8),
    activationProof: ActivationProofSchema.nullable(),
  })
  .superRefine((value, context) => {
    const expectedProvider = {
      "instagram-reel": "meta",
      "youtube-short": "youtube",
      "linkedin-video": "linkedin",
      "tiktok-video": "tiktok",
    }[value.id];
    if (value.provider !== expectedProvider) {
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message: "Provider does not match profile id.",
      });
    }
    if (
      !value.featureFlags.includes("repurpose_flow") ||
      (value.id === "tiktok-video" && !value.featureFlags.includes("publishing_tiktok"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["featureFlags"],
        message: "Required rollout flag is missing.",
      });
    }
    const liveMode = value.enabledModes.some((mode) => mode === "direct" || mode === "schedule");
    if (
      (value.enabled || liveMode) &&
      (value.status !== "approved_staging" || value.activationProof === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["activationProof"],
        message: "Live modes need approved staging evidence.",
      });
    }
    if (
      value.enabledModes.some(
        (mode) => !value.desiredModes.includes(mode) && mode !== "download_only",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["enabledModes"],
        message: "Enabled mode is not desired for this profile.",
      });
    }
  });

export const TestProfileRegistrySchema = z
  .strictObject({
    schemaVersion: z.literal(PLATFORM_PROFILE_SCHEMA_VERSION),
    registryVersion: z.string().trim().min(1).max(100),
    defaultEnabled: z.boolean(),
    profiles: z.array(TestProfileSchema).min(4).max(20),
  })
  .superRefine((value, context) => {
    const ids = value.profiles.map((profile) => profile.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["profiles"],
        message: "Profile ids must be unique.",
      });
    }
    if (value.defaultEnabled && value.profiles.some((profile) => !profile.enabled)) {
      context.addIssue({
        code: "custom",
        path: ["defaultEnabled"],
        message: "A disabled profile cannot be on by default.",
      });
    }
  });

export type TestProfile = z.infer<typeof TestProfileSchema>;
export type TestProfileRegistry = z.infer<typeof TestProfileRegistrySchema>;
