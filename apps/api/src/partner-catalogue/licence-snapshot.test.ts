import { describe, expect, it } from "vitest";

import { buildLicenceSnapshot, TODO_H28_LICENCE_TYPE } from "./licence-snapshot.js";

import type { PartnerLicenceTerms } from "./partner-catalogue.types.js";

const TERMS: PartnerLicenceTerms = {
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
  clearanceMethod: "channel_safelist",
  requiresUsageReport: true,
};

describe("buildLicenceSnapshot (TODO(H-28) placeholder)", () => {
  it("always marks the snapshot pending and tags licenceType with the TODO(H-28) sentinel", () => {
    const snapshot = buildLicenceSnapshot(TERMS);
    expect(snapshot.pending).toBe(true);
    expect(snapshot.licenceType).toBe(TODO_H28_LICENCE_TYPE);
    expect(snapshot.licenceType).toContain("H-28");
  });

  it("passes every other field through unchanged", () => {
    const snapshot = buildLicenceSnapshot(TERMS);
    expect(snapshot.territory).toEqual(TERMS.territory);
    expect(snapshot.clearanceMethod).toBe(TERMS.clearanceMethod);
    expect(snapshot.requiresUsageReport).toBe(TERMS.requiresUsageReport);
  });

  it("even a real-looking upstream licenceType is overwritten with the placeholder sentinel", () => {
    const snapshot = buildLicenceSnapshot({ ...TERMS, licenceType: "definitely_real" });
    expect(snapshot.licenceType).toBe(TODO_H28_LICENCE_TYPE);
  });
});
