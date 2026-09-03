import { describe, expect, it } from "vitest";

import { MockPartnerCatalogue } from "./mock-partner-catalogue.js";
import { AppException } from "../common/errors/error-codes.js";

import type { PartnerCatalogue } from "./partner-catalogue.types.js";

/**
 * Interface contract tests (D04b scope §5): exercised entirely against
 * `PartnerCatalogue`, never `MockPartnerCatalogue` directly, so the same
 * suite is ready to run against `EpidemicPartnerCatalogue` the day H-28
 * signs and it stops throwing the contract gate — no test here should need
 * to change, only the `catalogue` constructed below.
 */
function catalogueUnderTest(): PartnerCatalogue {
  return new MockPartnerCatalogue();
}

describe("PartnerCatalogue interface contract (mock adapter)", () => {
  it("search: an empty query returns every fixture hit", async () => {
    const catalogue = catalogueUnderTest();
    const result = await catalogue.search("");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.total).toBe(result.hits.length);
  });

  it("search: every hit refuses raw file delivery (D43)", async () => {
    const catalogue = catalogueUnderTest();
    const result = await catalogue.search("");
    for (const hit of result.hits) {
      expect(hit.allowsRawFileDelivery).toBe(false);
    }
  });

  it("search: a query narrows to matching titles/tags/mood", async () => {
    const catalogue = catalogueUnderTest();
    const result = await catalogue.search("corporate");
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      const haystack = [hit.title, ...hit.tags, ...hit.mood].join(" ").toLowerCase();
      expect(haystack).toContain("corporate");
    }
  });

  it("search: filters.kind narrows sfx (no bpm) vs music (has bpm)", async () => {
    const catalogue = catalogueUnderTest();
    const sfx = await catalogue.search("", { kind: "sfx" });
    const music = await catalogue.search("", { kind: "music" });
    expect(sfx.hits.every((hit) => hit.bpm === null)).toBe(true);
    expect(music.hits.every((hit) => hit.bpm !== null)).toBe(true);
    expect(sfx.hits.length + music.hits.length).toBeGreaterThan(0);
  });

  it("stream: returns a proxied, short-lived reference for a known asset", async () => {
    const catalogue = catalogueUnderTest();
    const result = await catalogue.search("");
    const first = result.hits[0];
    if (first === undefined) throw new Error("fixture must have at least one hit");
    const stream = await catalogue.stream(first.providerAssetId);
    expect(stream.proxied).toBe(true);
    expect(new Date(stream.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("stream: an unknown asset id is rejected", async () => {
    const catalogue = catalogueUnderTest();
    await expect(catalogue.stream("does-not-exist")).rejects.toBeInstanceOf(AppException);
  });

  it("grant -> reportUsage -> revoke is a coherent lifecycle", async () => {
    const catalogue = catalogueUnderTest();
    const result = await catalogue.search("");
    const first = result.hits[0];
    if (first === undefined) throw new Error("fixture must have at least one hit");

    const grant = await catalogue.grant({
      providerAssetId: first.providerAssetId,
      workspaceId: "ws_test",
      useContext: "pass_item",
    });
    expect(grant.status).toBe("active");
    expect(grant.providerAssetId).toBe(first.providerAssetId);

    const report = await catalogue.reportUsage({ grantId: grant.grantId, exportId: "exp_test" });
    expect(report.reportRef).toBeTruthy();
    expect(new Date(report.reportedAt).getTime()).toBeLessThanOrEqual(Date.now());

    await catalogue.revoke(grant.grantId);
    await expect(
      catalogue.reportUsage({ grantId: grant.grantId, exportId: "exp_test_2" }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("grant: an unknown provider asset id is rejected", async () => {
    const catalogue = catalogueUnderTest();
    await expect(
      catalogue.grant({
        providerAssetId: "does-not-exist",
        workspaceId: "ws_test",
        useContext: "pass_item",
      }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("reportUsage: an unknown grant id is rejected", async () => {
    const catalogue = catalogueUnderTest();
    await expect(
      catalogue.reportUsage({ grantId: "does-not-exist", exportId: "exp_test" }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("revoke: an unknown grant id is rejected", async () => {
    const catalogue = catalogueUnderTest();
    await expect(catalogue.revoke("does-not-exist")).rejects.toBeInstanceOf(AppException);
  });

  it("providerName identifies the adapter", () => {
    expect(catalogueUnderTest().providerName).toBe("mock");
  });
});
