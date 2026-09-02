import { describe, expect, it } from "vitest";

import { compareSemver, evaluateUpdateBanner } from "./manifestCheck.js";

describe("compareSemver", () => {
  it("orders patch/minor/major correctly", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareSemver("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });
});

describe("evaluateUpdateBanner", () => {
  const manifest = { minVersion: "0.2.0", maxVersion: "0.5.0", latestVersion: "0.4.0" };

  it("shows nothing when current is at latest", () => {
    expect(evaluateUpdateBanner("0.4.0", manifest)).toEqual({ show: false, severity: "none" });
  });

  it("shows update-available between min and latest", () => {
    expect(evaluateUpdateBanner("0.3.0", manifest)).toMatchObject({
      show: true,
      severity: "update-available",
      latestVersion: "0.4.0",
    });
  });

  it("shows unsupported below min", () => {
    expect(evaluateUpdateBanner("0.1.0", manifest)).toMatchObject({
      show: true,
      severity: "unsupported",
    });
  });
});
