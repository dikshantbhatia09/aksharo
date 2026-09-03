import { describe, expect, it } from "vitest";

import {
  partnerHitsToMusicRows,
  partnerHitsToSfxRows,
  partnerRowId,
} from "./partner-catalogue-items.js";

import type { PartnerSearchHit } from "../partner-catalogue/partner-catalogue.types.js";

function hit(overrides: Partial<PartnerSearchHit>): PartnerSearchHit {
  return {
    providerAssetId: "mock-sfx-0001",
    provider: "mock",
    title: "Fixture whoosh",
    tags: ["whoosh"],
    mood: [],
    bpm: null,
    durationMs: 900,
    licence: {
      licenceType: "sync",
      territory: ["WORLD"],
      termStart: null,
      termEnd: null,
      allowsCommercialUse: true,
      allowsMonetisation: true,
      allowsPaidAds: false,
      allowsBroadcast: false,
      requiresAttribution: false,
      attributionText: null,
      clearanceMethod: "platform_covered",
      requiresUsageReport: true,
    },
    allowsRawFileDelivery: false,
    ...overrides,
  };
}

describe("partnerHitsToSfxRows (D04b2)", () => {
  it("maps a bpm-null hit into the sfxCatalogueOf row shape", () => {
    const rows = partnerHitsToSfxRows([hit({})]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: partnerRowId("mock-sfx-0001"),
      packId: "partner-catalogue",
      cueType: null,
      tags: ["whoosh"],
    });
    expect(rows[0]?.embedding).toHaveLength(512);
    expect(rows[0]?.embedding.every((value) => value === 0)).toBe(true);
    expect(rows[0]?.licenceSnapshot["partner"]).toBe(true);
    expect(rows[0]?.licenceSnapshot["allowsRawFileDelivery"]).toBe(false);
  });

  it("excludes music hits (bpm !== null)", () => {
    const rows = partnerHitsToSfxRows([hit({ providerAssetId: "mock-music-0001", bpm: 120 })]);
    expect(rows).toHaveLength(0);
  });
});

describe("partnerHitsToMusicRows (D04b2)", () => {
  it("maps a bpm-set hit into the musicCatalogueOf row shape", () => {
    const rows = partnerHitsToMusicRows([
      hit({
        providerAssetId: "mock-music-0001",
        bpm: 120,
        mood: ["energetic"],
        durationMs: 92_000,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: partnerRowId("mock-music-0001"),
      packId: "partner-catalogue",
      mood: ["energetic"],
      bpm: 120,
      introMs: null,
      outroMs: null,
      durationMs: 92_000,
    });
    expect(rows[0]?.embedding).toHaveLength(512);
  });

  it("excludes sfx hits (bpm === null)", () => {
    const rows = partnerHitsToMusicRows([hit({})]);
    expect(rows).toHaveLength(0);
  });
});
