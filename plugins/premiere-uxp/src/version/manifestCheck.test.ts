import { describe, expect, it } from "vitest";

import { compareSemver, evaluateUpdateBanner } from "./manifestCheck.js";

describe("compareSemver", () => {
  it("orders versions numerically, not lexically", () => {
    expect(compareSemver("1.2.0", "1.10.0")).toBeLessThan(0);
  });

  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });
});

describe("evaluateUpdateBanner", () => {
  const manifest = { minVersion: "0.2.0", maxVersion: "2.0.0", latestVersion: "0.5.0" };

  it("shows nothing when current is at latest", () => {
    expect(evaluateUpdateBanner("0.5.0", manifest)).toEqual({ show: false, severity: "none" });
  });

  it("shows update-available when behind latest but above min", () => {
    expect(evaluateUpdateBanner("0.3.0", manifest)).toEqual({
      show: true,
      severity: "update-available",
      latestVersion: "0.5.0",
      updateUrl: undefined,
    });
  });

  it("shows unsupported when below min", () => {
    expect(evaluateUpdateBanner("0.1.0", manifest)).toEqual({
      show: true,
      severity: "unsupported",
      latestVersion: "0.5.0",
      updateUrl: undefined,
    });
  });

  it("carries updateUrl through", () => {
    const result = evaluateUpdateBanner("0.1.0", { ...manifest, updateUrl: "https://x/y" });
    expect(result.updateUrl).toBe("https://x/y");
  });
});
