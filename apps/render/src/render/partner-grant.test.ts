import { describe, expect, it, vi } from "vitest";

import {
  assertPartnerGrantForTrack,
  isPartnerCatalogueTrack,
  PARTNER_CATALOGUE_PACK_ID,
  providerAssetIdFromTrackAssetId,
} from "./partner-grant.js";

describe("isPartnerCatalogueTrack / providerAssetIdFromTrackAssetId", () => {
  it("recognises the sentinel packId", () => {
    expect(isPartnerCatalogueTrack(PARTNER_CATALOGUE_PACK_ID)).toBe(true);
    expect(isPartnerCatalogueTrack("fixture-pack-01")).toBe(false);
  });

  it("strips the partner: prefix from an assetId", () => {
    expect(providerAssetIdFromTrackAssetId("partner:mock-sfx-0001")).toBe("mock-sfx-0001");
    expect(providerAssetIdFromTrackAssetId("01JEXXXXXXXXXXXXXXXXXXXXXX")).toBe(
      "01JEXXXXXXXXXXXXXXXXXXXXXX",
    );
  });
});

describe("assertPartnerGrantForTrack", () => {
  it("does nothing for a non-partner track — never calls verify", async () => {
    const verify = vi.fn();
    await expect(
      assertPartnerGrantForTrack({ packId: "fixture-pack-01", assetId: "asset-1" }, "ws1", verify),
    ).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it("resolves when verify returns true for a partner track", async () => {
    const verify = vi.fn().mockResolvedValue(true);
    await expect(
      assertPartnerGrantForTrack(
        { packId: PARTNER_CATALOGUE_PACK_ID, assetId: "partner:mock-sfx-0001" },
        "ws1",
        verify,
      ),
    ).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledWith({ workspaceId: "ws1", providerAssetId: "mock-sfx-0001" });
  });

  it("throws when verify returns false", async () => {
    const verify = vi.fn().mockResolvedValue(false);
    await expect(
      assertPartnerGrantForTrack(
        { packId: PARTNER_CATALOGUE_PACK_ID, assetId: "partner:mock-sfx-0001" },
        "ws1",
        verify,
      ),
    ).rejects.toThrow(/grant not valid/);
  });

  it("throws (fails closed) when no verify function is configured", async () => {
    await expect(
      assertPartnerGrantForTrack(
        { packId: PARTNER_CATALOGUE_PACK_ID, assetId: "partner:mock-sfx-0001" },
        "ws1",
        undefined,
      ),
    ).rejects.toThrow(/grant not valid/);
  });
});
