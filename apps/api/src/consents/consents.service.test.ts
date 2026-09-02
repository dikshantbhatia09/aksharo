import { describe, expect, it } from "vitest";

import { CONSENT_PURPOSES, setConsentSchema } from "./consents.dto.js";
import { mirrorOntoUser } from "./consents.service.js";

const AT = new Date("2026-09-02T10:00:00.000Z");

describe("CONSENT_PURPOSES", () => {
  it("covers every purpose in the 06 enum, so nothing is unanswerable", () => {
    expect([...CONSENT_PURPOSES]).toEqual([
      "analytics",
      "memory",
      "marketing",
      "share_upload",
      "affiliate",
      "telemetry",
    ]);
  });

  it("is the closed set the request schema accepts", () => {
    expect(setConsentSchema.safeParse({ purpose: "analytics", granted: true }).success).toBe(true);
    expect(setConsentSchema.safeParse({ purpose: "telemetry", granted: true }).success).toBe(true);
    expect(setConsentSchema.safeParse({ purpose: "bogus", granted: true }).success).toBe(false);
    // `granted` is required: an absent boolean would silently become a refusal.
    expect(setConsentSchema.safeParse({ purpose: "analytics" }).success).toBe(false);
  });
});

describe("mirrorOntoUser", () => {
  it("writes the boolean column for marketing", () => {
    expect(mirrorOntoUser("marketing", true, AT)).toEqual({ marketingOptIn: true });
    expect(mirrorOntoUser("marketing", false, AT)).toEqual({ marketingOptIn: false });
  });

  it("writes a timestamp for analytics and memory, and clears it on withdrawal", () => {
    expect(mirrorOntoUser("analytics", true, AT)).toEqual({ analyticsConsentAt: AT });
    expect(mirrorOntoUser("analytics", false, AT)).toEqual({ analyticsConsentAt: null });
    expect(mirrorOntoUser("memory", true, AT)).toEqual({ memoryConsentAt: AT });
    expect(mirrorOntoUser("memory", false, AT)).toEqual({ memoryConsentAt: null });
  });

  it("has nothing to mirror for the purposes 06 keeps only as records", () => {
    expect(mirrorOntoUser("share_upload", true, AT)).toBeNull();
    expect(mirrorOntoUser("affiliate", true, AT)).toBeNull();
  });
});
