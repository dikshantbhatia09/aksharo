import { describe, expect, it } from "vitest";

import { decideExport, type ExportDecisionInput } from "./decision.js";
import { AppException } from "../common/errors/error-codes.js";

const FREE_ENTITLEMENTS = {
  watermark: "after_first_clean_export",
  maxExportResolution: "1080p",
  maxDurationMs: 20 * 60_000,
  subtitleFormats: ["srt", "vtt", "txt"],
};

const CREATOR_ENTITLEMENTS = {
  watermark: "none",
  maxExportResolution: "4k",
  maxDurationMs: 3 * 60 * 60_000,
  subtitleFormats: ["srt", "vtt", "txt", "ass", "docx", "md"],
};

const STARTER_ENTITLEMENTS = {
  watermark: "none",
  maxExportResolution: "1080p",
  maxDurationMs: 60 * 60_000,
  subtitleFormats: ["srt", "vtt", "txt", "ass"],
};

const MIN = 60_000;

function base(overrides: Partial<ExportDecisionInput> = {}): ExportDecisionInput {
  return {
    requestedMode: "auto",
    kind: "video",
    outputKind: "video",
    preset: "reels",
    sourceDurationMs: 5 * MIN,
    outputDurationMs: 5 * MIN,
    plan: "free",
    entitlements: FREE_ENTITLEMENTS,
    signupGiftAvailable: false,
    ninePassAvailable: false,
    ...overrides,
  };
}

describe("decideExport — video, browser eligibility", () => {
  it("1080p, short, auto -> browser", () => {
    const decision = decideExport(base());
    expect(decision.path).toBe("browser");
  });

  it("1080p, exactly 20 minutes -> browser (inclusive)", () => {
    const decision = decideExport(base({ outputDurationMs: 20 * MIN, sourceDurationMs: 20 * MIN }));
    expect(decision.path).toBe("browser");
  });

  it("1080p, 20 minutes and one second -> cloud", () => {
    const decision = decideExport(
      base({ outputDurationMs: 20 * MIN + 1_000, sourceDurationMs: 20 * MIN + 1_000 }),
    );
    expect(decision.path).toBe("cloud");
    expect(decision.reasons.join(" ")).toMatch(/cloud/i);
  });

  it("mobile capability -> cloud even for a short 1080p clip", () => {
    const decision = decideExport(base({ capabilities: { isMobile: true } }));
    expect(decision.path).toBe("cloud");
  });

  it("alpha output -> always cloud", () => {
    const decision = decideExport(
      base({ outputKind: "alpha", entitlements: CREATOR_ENTITLEMENTS }),
    );
    expect(decision.path).toBe("cloud");
  });

  it("greenscreen output -> always cloud", () => {
    const decision = decideExport(
      base({ outputKind: "greenscreen", entitlements: CREATOR_ENTITLEMENTS }),
    );
    expect(decision.path).toBe("cloud");
  });

  it("4K preset without desktop capability -> cloud", () => {
    const decision = decideExport(
      base({
        preset: "youtube-4k",
        entitlements: CREATOR_ENTITLEMENTS,
        outputDurationMs: 5 * MIN,
        sourceDurationMs: 5 * MIN,
      }),
    );
    expect(decision.path).toBe("cloud");
  });

  it("4K preset, desktop Chromium, fileSink, <=10min -> browser", () => {
    const decision = decideExport(
      base({
        preset: "youtube-4k",
        entitlements: CREATOR_ENTITLEMENTS,
        outputDurationMs: 9 * MIN,
        sourceDurationMs: 9 * MIN,
        capabilities: { isDesktopChromium: true, fileSink: true },
      }),
    );
    expect(decision.path).toBe("browser");
  });

  it("4K preset, desktop Chromium, fileSink, >10min -> cloud", () => {
    const decision = decideExport(
      base({
        preset: "youtube-4k",
        entitlements: CREATOR_ENTITLEMENTS,
        outputDurationMs: 11 * MIN,
        sourceDurationMs: 11 * MIN,
        capabilities: { isDesktopChromium: true, fileSink: true },
      }),
    );
    expect(decision.path).toBe("cloud");
  });

  it("4K preset, fileSink but not desktop Chromium -> cloud", () => {
    const decision = decideExport(
      base({
        preset: "youtube-4k",
        entitlements: CREATOR_ENTITLEMENTS,
        outputDurationMs: 5 * MIN,
        sourceDurationMs: 5 * MIN,
        capabilities: { isDesktopChromium: false, fileSink: true },
      }),
    );
    expect(decision.path).toBe("cloud");
  });

  it("custom preset >=2560 wide is treated as 4K-class", () => {
    const decision = decideExport(
      base({
        preset: "custom",
        customWidth: 3_000,
        customHeight: 3_000,
        entitlements: CREATOR_ENTITLEMENTS,
        outputDurationMs: 5 * MIN,
        sourceDurationMs: 5 * MIN,
        capabilities: { isDesktopChromium: true, fileSink: true },
      }),
    );
    expect(decision.path).toBe("browser");
  });

  it("4K on a Free plan is refused outright (entitlement gate before path)", () => {
    expect(() => decideExport(base({ preset: "youtube-4k" }))).toThrow(AppException);
  });

  it("4K on Starter (1080p plan) is refused outright", () => {
    expect(() =>
      decideExport(
        base({ preset: "youtube-4k", entitlements: STARTER_ENTITLEMENTS, plan: "starter" }),
      ),
    ).toThrow(AppException);
  });
});

describe("decideExport — requested mode overrides", () => {
  it("explicit cloud mode always cloud, even when browser-eligible", () => {
    const decision = decideExport(base({ requestedMode: "cloud" }));
    expect(decision.path).toBe("cloud");
    expect(decision.reasons).toContain("Cloud render requested.");
  });

  it("explicit browser mode succeeds when eligible", () => {
    const decision = decideExport(base({ requestedMode: "browser" }));
    expect(decision.path).toBe("browser");
  });

  it("explicit browser mode throws export/unsupported_in_browser when ineligible", () => {
    try {
      decideExport(
        base({ requestedMode: "browser", outputKind: "alpha", entitlements: CREATOR_ENTITLEMENTS }),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe("export/unsupported_in_browser");
    }
  });

  it("explicit browser mode over 20 minutes throws", () => {
    expect(() =>
      decideExport(
        base({ requestedMode: "browser", outputDurationMs: 25 * MIN, sourceDurationMs: 25 * MIN }),
      ),
    ).toThrow(AppException);
  });
});

describe("decideExport — watermark: Free plan", () => {
  it("no gift, no pass -> watermarked", () => {
    const decision = decideExport(base());
    expect(decision.watermark).toBe(true);
    expect(decision.watermarkSource).toBe("none");
  });

  it("signup gift available, browser, <=10min -> clean, consumes gift", () => {
    const decision = decideExport(
      base({ signupGiftAvailable: true, sourceDurationMs: 8 * MIN, outputDurationMs: 8 * MIN }),
    );
    expect(decision.watermark).toBe(false);
    expect(decision.watermarkSource).toBe("signup_gift");
    expect(decision.consumesSignupGift).toBe(true);
    expect(decision.consumesNinePass).toBe(false);
  });

  it("signup gift available but source > 10min -> still watermarked", () => {
    const decision = decideExport(
      base({ signupGiftAvailable: true, sourceDurationMs: 12 * MIN, outputDurationMs: 12 * MIN }),
    );
    expect(decision.watermark).toBe(true);
    expect(decision.consumesSignupGift).toBe(false);
  });

  it("signup gift available but path is cloud (forced) -> not consumed, watermarked", () => {
    const decision = decideExport(base({ signupGiftAvailable: true, requestedMode: "cloud" }));
    expect(decision.path).toBe("cloud");
    expect(decision.watermark).toBe(true);
    expect(decision.consumesSignupGift).toBe(false);
  });

  it("nine-pass available, no gift, browser, <=10min -> clean, consumes pass", () => {
    const decision = decideExport(
      base({ ninePassAvailable: true, sourceDurationMs: 6 * MIN, outputDurationMs: 6 * MIN }),
    );
    expect(decision.watermark).toBe(false);
    expect(decision.watermarkSource).toBe("nine_pass");
    expect(decision.consumesNinePass).toBe(true);
  });

  it("gift takes priority over the nine-pass when both are available", () => {
    const decision = decideExport(
      base({
        signupGiftAvailable: true,
        ninePassAvailable: true,
        sourceDurationMs: 4 * MIN,
        outputDurationMs: 4 * MIN,
      }),
    );
    expect(decision.consumesSignupGift).toBe(true);
    expect(decision.consumesNinePass).toBe(false);
  });

  it("nine-pass available but source > 10 min -> watermarked", () => {
    const decision = decideExport(
      base({ ninePassAvailable: true, sourceDurationMs: 15 * MIN, outputDurationMs: 15 * MIN }),
    );
    expect(decision.watermark).toBe(true);
  });
});

describe("decideExport — watermark: paid plans", () => {
  it("Starter -> never watermarked", () => {
    const decision = decideExport(base({ entitlements: STARTER_ENTITLEMENTS, plan: "starter" }));
    expect(decision.watermark).toBe(false);
    expect(decision.watermarkSource).toBe("plan");
  });

  it("Creator -> never watermarked, even on a long cloud render", () => {
    const decision = decideExport(
      base({
        entitlements: CREATOR_ENTITLEMENTS,
        plan: "creator",
        outputDurationMs: 40 * MIN,
        sourceDurationMs: 40 * MIN,
      }),
    );
    expect(decision.path).toBe("cloud");
    expect(decision.watermark).toBe(false);
  });
});

describe("decideExport — caps embedded in the decision", () => {
  it("Free browser caps: 1920 square, 20 minutes", () => {
    const decision = decideExport(base());
    expect(decision.maxWidth).toBe(1_920);
    expect(decision.maxHeight).toBe(1_920);
    expect(decision.maxDurationMs).toBe(20 * MIN);
    expect(decision.allowAlpha).toBe(false);
  });

  it("Creator cloud 4K caps: 3840 square, plan duration cap", () => {
    const decision = decideExport(
      base({
        preset: "youtube-4k",
        entitlements: CREATOR_ENTITLEMENTS,
        plan: "creator",
        requestedMode: "cloud",
      }),
    );
    expect(decision.maxWidth).toBe(3_840);
    expect(decision.maxDurationMs).toBeGreaterThanOrEqual(3 * 60 * MIN);
  });

  it("alpha output cloud -> allowAlpha true", () => {
    const decision = decideExport(
      base({ outputKind: "alpha", entitlements: CREATOR_ENTITLEMENTS, plan: "creator" }),
    );
    expect(decision.allowAlpha).toBe(true);
  });

  it("video output cloud -> allowAlpha false", () => {
    const decision = decideExport(
      base({ requestedMode: "cloud", entitlements: CREATOR_ENTITLEMENTS, plan: "creator" }),
    );
    expect(decision.allowAlpha).toBe(false);
  });
});

describe("decideExport — credit estimate", () => {
  it("browser path is free", () => {
    const decision = decideExport(base());
    expect(decision.creditEstimateTenths).toBe(0);
  });

  it("cloud path costs 0.5 credits/output-minute, on the 0.1-minute billing quantum (B02b: quote())", () => {
    const decision = decideExport(base({ requestedMode: "cloud", outputDurationMs: 90_000 }));
    // 90s = 1.5 output minutes = 15 deciminutes exactly (no rounding needed) ->
    // 15 * 5 tenths / 10 = 7.5, rounded up to 8 tenths. Routed through
    // `@montaj/config`'s `quote()`, which bills the same 0.1-minute quantum
    // `render-completion.handler.ts` settles on — NOT whole-minute rounding
    // (which would have overcharged this to 2 minutes -> 10 tenths).
    expect(decision.creditEstimateTenths).toBe(8);
  });

  it("cloud path: exact minute boundary does not round up an extra minute", () => {
    const decision = decideExport(base({ requestedMode: "cloud", outputDurationMs: 3 * MIN }));
    expect(decision.creditEstimateTenths).toBe(15);
  });

  it("cloud path: a duration inside one deciminute still rounds up to it, never to zero", () => {
    const decision = decideExport(base({ requestedMode: "cloud", outputDurationMs: 1_000 }));
    // 1s rounds up to one 0.1-minute quantum -> 5 * 1 / 10 = 0.5, rounded up to 1 tenth.
    expect(decision.creditEstimateTenths).toBe(1);
  });

  it("subtitle requests are always free", () => {
    const decision = decideExport(base({ kind: "subtitle", subtitleFormats: ["srt"] }));
    expect(decision.creditEstimateTenths).toBe(0);
    expect(decision.path).toBe("cloud");
  });
});

describe("decideExport — subtitles", () => {
  it("srt/vtt/txt on Free -> allowed", () => {
    const decision = decideExport(
      base({ kind: "subtitle", subtitleFormats: ["srt", "vtt", "txt"] }),
    );
    expect(decision.path).toBe("cloud");
    expect(decision.watermark).toBe(false);
  });

  it("md on Free -> refused (needs Creator+)", () => {
    expect(() => decideExport(base({ kind: "subtitle", subtitleFormats: ["md"] }))).toThrow(
      AppException,
    );
  });

  it("md on Creator -> allowed", () => {
    const decision = decideExport(
      base({
        kind: "subtitle",
        subtitleFormats: ["md"],
        entitlements: CREATOR_ENTITLEMENTS,
        plan: "creator",
      }),
    );
    expect(decision.path).toBe("cloud");
  });

  it("ass -> refused when the project's styles have not passed the A18a parity gate", () => {
    expect(() =>
      decideExport(
        base({
          kind: "subtitle",
          subtitleFormats: ["ass"],
          entitlements: CREATOR_ENTITLEMENTS,
          plan: "creator",
          assStylesRenderable: false,
        }),
      ),
    ).toThrow(AppException);
  });

  it("ass -> refused by default, when the caller says nothing about renderability", () => {
    expect(() =>
      decideExport(
        base({
          kind: "subtitle",
          subtitleFormats: ["ass"],
          entitlements: CREATOR_ENTITLEMENTS,
          plan: "creator",
        }),
      ),
    ).toThrow(AppException);
  });

  it("ass -> allowed once every referenced style is assRenderable and the plan lists ass", () => {
    const decision = decideExport(
      base({
        kind: "subtitle",
        subtitleFormats: ["ass"],
        entitlements: CREATOR_ENTITLEMENTS,
        plan: "creator",
        assStylesRenderable: true,
      }),
    );
    expect(decision.path).toBe("cloud");
  });

  it("explicit browser mode for subtitles is coerced to cloud with a reason, not an error", () => {
    const decision = decideExport(
      base({ kind: "subtitle", requestedMode: "browser", subtitleFormats: ["srt"] }),
    );
    expect(decision.path).toBe("cloud");
    expect(decision.reasons.join(" ")).toMatch(/no browser subtitle path/i);
  });
});

describe("decideExport — reasons are non-empty, UI-safe strings", () => {
  const cases: Partial<ExportDecisionInput>[] = [
    {},
    { requestedMode: "cloud" },
    { outputKind: "alpha", entitlements: CREATOR_ENTITLEMENTS },
    { signupGiftAvailable: true, sourceDurationMs: 5 * MIN, outputDurationMs: 5 * MIN },
    { kind: "subtitle", subtitleFormats: ["srt"] },
  ];

  for (const [index, overrides] of cases.entries()) {
    it(`case ${String(index)} has at least one human-readable reason`, () => {
      const decision = decideExport(base(overrides));
      expect(decision.reasons.length).toBeGreaterThan(0);
      for (const reason of decision.reasons) {
        expect(typeof reason).toBe("string");
        expect(reason.length).toBeGreaterThan(0);
      }
    });
  }
});
