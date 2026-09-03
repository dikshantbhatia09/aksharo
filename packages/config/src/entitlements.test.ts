import { describe, expect, it } from "vitest";

import { LOCAL_MODE_MIN_PLAN, hasLocalMode, planAtLeast } from "./entitlements.js";

describe("planAtLeast", () => {
  it("orders the ladder free < starter < creator < studio < agency", () => {
    expect(planAtLeast("free", "starter")).toBe(false);
    expect(planAtLeast("starter", "starter")).toBe(true);
    expect(planAtLeast("creator", "starter")).toBe(true);
    expect(planAtLeast("studio", "creator")).toBe(true);
    expect(planAtLeast("agency", "studio")).toBe(true);
    expect(planAtLeast("starter", "agency")).toBe(false);
  });
});

describe("hasLocalMode", () => {
  it("matches the seed data ladder: free blocked, starter and above allowed", () => {
    expect(LOCAL_MODE_MIN_PLAN).toBe("starter");
    expect(hasLocalMode("free")).toBe(false);
    expect(hasLocalMode("starter")).toBe(true);
    expect(hasLocalMode("creator")).toBe(true);
    expect(hasLocalMode("studio")).toBe(true);
    expect(hasLocalMode("agency")).toBe(true);
  });
});
