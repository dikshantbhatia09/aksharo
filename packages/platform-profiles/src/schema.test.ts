import { describe, expect, it } from "vitest";

import { TEST_PROFILE_REGISTRY } from "./index.js";
import { TEST_PROFILE_IDS, TestProfileRegistrySchema, TestProfileSchema } from "./schema.js";

describe("platform-profile@1 test registry", () => {
  it("loads exactly four disabled profiles and leaves posting modes off", () => {
    expect(TEST_PROFILE_REGISTRY.defaultEnabled).toBe(false);
    expect(TEST_PROFILE_REGISTRY.profiles.map((profile) => profile.id)).toEqual(TEST_PROFILE_IDS);
    for (const profile of TEST_PROFILE_REGISTRY.profiles) {
      expect(profile.enabled).toBe(false);
      expect(profile.status).toBe("test_only");
      expect(profile.enabledModes).toEqual(["download_only"]);
      expect(profile.activationProof).toBeNull();
      expect(profile.needsLiveAccountCapabilityCheck).toBe(true);
      expect(profile.sources.length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown version, duplicates, bad aspect and fake sources", () => {
    const registry = structuredClone(TEST_PROFILE_REGISTRY);
    expect(TestProfileRegistrySchema.safeParse({ ...registry, schemaVersion: 2 }).success).toBe(
      false,
    );
    registry.profiles[1] = { ...registry.profiles[1]!, id: registry.profiles[0]!.id };
    expect(TestProfileRegistrySchema.safeParse(registry).success).toBe(false);
    const profile = TEST_PROFILE_REGISTRY.profiles[0]!;
    expect(
      TestProfileSchema.safeParse({
        ...profile,
        preparation: { ...profile.preparation, width: 1000 },
      }).success,
    ).toBe(false);
    expect(
      TestProfileSchema.safeParse({
        ...profile,
        sources: [
          {
            url: "https://evil.example/specs",
            sourceType: "official_docs",
            checkedAt: "2026-09-15",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects direct or scheduled enablement without account/review/staging proof", () => {
    const profile = TEST_PROFILE_REGISTRY.profiles[0]!;
    expect(TestProfileSchema.safeParse({ ...profile, enabled: true }).success).toBe(false);
    expect(TestProfileSchema.safeParse({ ...profile, enabledModes: ["direct"] }).success).toBe(
      false,
    );
    expect(TestProfileSchema.safeParse({ ...profile, enabledModes: ["schedule"] }).success).toBe(
      false,
    );
  });

  it("allows structurally complete staging evidence without asserting its truth", () => {
    const profile = TEST_PROFILE_REGISTRY.profiles[0]!;
    const reviewed = {
      ...profile,
      status: "approved_staging",
      enabled: true,
      enabledModes: ["download_only", "direct"],
      activationProof: {
        credentialOwnerRef: "protected/owner-1",
        scopesEvidenceRef: "protected/scopes-1",
        appReviewEvidenceRef: "protected/review-1",
        testAccountEvidenceRef: "protected/account-1",
        smokeEvidenceRef: "protected/smoke-1",
        lastVerifiedAt: "2026-09-15T00:00:00.000Z",
      },
    };
    expect(TestProfileSchema.safeParse(reviewed).success).toBe(true);
    expect(TestProfileSchema.safeParse({ ...reviewed, activationProof: null }).success).toBe(false);
  });

  it("keeps provider routing, flags, mode scope and default enablement coherent", () => {
    const profile = TEST_PROFILE_REGISTRY.profiles[3]!;
    expect(TestProfileSchema.safeParse({ ...profile, provider: "meta" }).success).toBe(false);
    expect(
      TestProfileSchema.safeParse({ ...profile, featureFlags: ["repurpose_flow"] }).success,
    ).toBe(false);
    expect(
      TestProfileSchema.safeParse({ ...profile, enabledModes: ["mobile_handoff"] }).success,
    ).toBe(false);
    expect(
      TestProfileRegistrySchema.safeParse({ ...TEST_PROFILE_REGISTRY, defaultEnabled: true })
        .success,
    ).toBe(false);
  });
});
