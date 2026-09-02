import { describe, expect, it } from "vitest";

import { decideExport, type ExportDecisionInput } from "../exports/decision.js";

/**
 * Acceptance criterion 1: "a ₹9 purchase never applies to cloud renders
 * (decision engine test)." `exports/decision.ts#chooseWatermark` (A21) already
 * guards this — a ₹9 pass only clears a watermark on the browser path, ≤ 10
 * minutes — this test exercises the real, shipped `decideExport` (not a
 * reimplementation) with `ninePassAvailable: true` to prove the guarantee this
 * work package's own `NinePassLedger.isAvailable` returning `true` cannot be
 * turned into a free watermark-free cloud render.
 */
const FREE_ENTITLEMENTS = {
  watermark: "gated",
  maxExportResolution: "1080p",
} as const;

function baseInput(overrides: Partial<ExportDecisionInput> = {}): ExportDecisionInput {
  return {
    requestedMode: "cloud",
    kind: "video",
    outputKind: "video",
    preset: "reels",
    sourceDurationMs: 5 * 60_000,
    outputDurationMs: 5 * 60_000,
    plan: "free",
    entitlements: FREE_ENTITLEMENTS,
    signupGiftAvailable: false,
    ninePassAvailable: true,
    ...overrides,
  };
}

describe("₹9 pass never clears a watermark on the cloud path", () => {
  it("explicit cloud request: watermarked, nine-pass not consumed, no credit discount", () => {
    const decision = decideExport(baseInput({ requestedMode: "cloud" }));
    expect(decision.path).toBe("cloud");
    expect(decision.watermark).toBe(true);
    expect(decision.watermarkSource).toBe("none");
    expect(decision.consumesNinePass).toBe(false);
  });

  it("auto mode that falls back to cloud (over the browser length cap): still watermarked", () => {
    const decision = decideExport(
      baseInput({
        requestedMode: "auto",
        sourceDurationMs: 25 * 60_000,
        outputDurationMs: 25 * 60_000,
      }),
    );
    expect(decision.path).toBe("cloud");
    expect(decision.watermark).toBe(true);
    expect(decision.consumesNinePass).toBe(false);
  });

  it("auto mode, mobile capability probe forces cloud: still watermarked despite an available pass", () => {
    const decision = decideExport(
      baseInput({ requestedMode: "auto", capabilities: { isMobile: true } }),
    );
    expect(decision.path).toBe("cloud");
    expect(decision.watermark).toBe(true);
    expect(decision.consumesNinePass).toBe(false);
  });

  it("control: the same pass DOES clear the watermark on the browser path, ≤ 10 minutes", () => {
    const decision = decideExport(
      baseInput({
        requestedMode: "browser",
        sourceDurationMs: 5 * 60_000,
        outputDurationMs: 5 * 60_000,
        capabilities: { codecs: ["avc1.42001f"], audioEncoder: true },
      }),
    );
    expect(decision.path).toBe("browser");
    expect(decision.watermark).toBe(false);
    expect(decision.watermarkSource).toBe("nine_pass");
    expect(decision.consumesNinePass).toBe(true);
  });

  it("control: the pass does NOT clear the watermark on the browser path past 10 minutes", () => {
    const decision = decideExport(
      baseInput({
        requestedMode: "browser",
        sourceDurationMs: 11 * 60_000,
        outputDurationMs: 11 * 60_000,
        capabilities: { codecs: ["avc1.42001f"], audioEncoder: true },
      }),
    );
    expect(decision.path).toBe("browser");
    expect(decision.watermark).toBe(true);
    expect(decision.consumesNinePass).toBe(false);
  });
});
