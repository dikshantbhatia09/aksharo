import { describe, expect, it } from "vitest";

import { checkLicenceForPanel } from "./licence.js";

describe("checkLicenceForPanel", () => {
  it("allows an owned asset licensed for the panel surface", () => {
    const result = checkLicenceForPanel({
      allowsRawFileDelivery: true,
      surface: ["panel", "cloud_render"],
    });
    expect(result).toEqual({ allowed: true, reasons: [] });
  });

  it("refuses a partner asset with allowsRawFileDelivery=false", () => {
    const result = checkLicenceForPanel({
      allowsRawFileDelivery: false,
      surface: ["cloud_render"],
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("not-owned");
    expect(result.reasons).toContain("surface-not-allowed");
  });

  it("refuses an owned asset whose snapshot surface list omits panel", () => {
    const result = checkLicenceForPanel({ allowsRawFileDelivery: true, surface: ["cloud_render"] });
    expect(result).toEqual({ allowed: false, reasons: ["surface-not-allowed"] });
  });
});
