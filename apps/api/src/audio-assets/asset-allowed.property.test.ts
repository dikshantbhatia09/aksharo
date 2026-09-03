import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { assetAllowed, type AssetAllowedInput, type PlanTier } from "./asset-allowed.js";

const providers = ["owned", "epidemic", "soundstripe", "storyblocks", "beatoven", "hoopr"] as const;
const clearanceMethods = [
  "none",
  "channel_safelist",
  "per_video_code",
  "platform_covered",
] as const;
const surfaces = ["cloud_render", "panel", "desktop", "api"] as const;
const plans: readonly PlanTier[] = ["free", "starter", "creator", "studio", "agency"];

const assetArb = fc.record<AssetAllowedInput>({
  provider: fc.constantFrom(...providers),
  territory: fc.uniqueArray(fc.constantFrom("WORLD", "US", "IN", "GB", "DE"), {
    minLength: 0,
    maxLength: 3,
  }),
  termStart: fc.option(fc.date({ min: new Date(2020, 0, 1), max: new Date(2030, 0, 1) }), {
    nil: null,
  }),
  termEnd: fc.option(fc.date({ min: new Date(2020, 0, 1), max: new Date(2030, 0, 1) }), {
    nil: null,
  }),
  allowsRawFileDelivery: fc.boolean(),
  clearanceMethod: fc.constantFrom(...clearanceMethods),
});

const contextArb = fc.record({
  surface: fc.constantFrom(...surfaces),
  plan: fc.constantFrom(...plans),
  territory: fc.constantFrom("WORLD", "US", "IN", "GB", "DE", "FR"),
});

describe("assetAllowed (D04a licence predicate, property tests)", () => {
  it("never allows delivery to panel/desktop/api unless allowsRawFileDelivery is true", () => {
    fc.assert(
      fc.property(assetArb, contextArb, (asset, context) => {
        const result = assetAllowed(asset, context);
        if (context.surface !== "cloud_render" && !asset.allowsRawFileDelivery) {
          expect(result.allowed).toBe(false);
          expect(result.reasons).toContain("surface-requires-owned");
        }
      }),
    );
  });

  it("is monotonic: relaxing surface to cloud_render can only ever allow more, never fewer, assets", () => {
    fc.assert(
      fc.property(assetArb, contextArb, (asset, context) => {
        const restrictive = assetAllowed(asset, context);
        const relaxed = assetAllowed(asset, { ...context, surface: "cloud_render" });
        if (restrictive.allowed) {
          expect(relaxed.allowed).toBe(true);
        }
      }),
    );
  });

  it("never allows a partner asset below the studio plan", () => {
    fc.assert(
      fc.property(assetArb, contextArb, (asset, context) => {
        const result = assetAllowed(asset, context);
        if (
          asset.provider !== "owned" &&
          (context.plan === "free" || context.plan === "starter" || context.plan === "creator")
        ) {
          expect(result.allowed).toBe(false);
        }
      }),
    );
  });

  it("never allows a partner asset with clearanceMethod none", () => {
    fc.assert(
      fc.property(assetArb, contextArb, (asset, context) => {
        const result = assetAllowed(asset, context);
        if (asset.provider !== "owned" && asset.clearanceMethod === "none") {
          expect(result.allowed).toBe(false);
        }
      }),
    );
  });

  it("respects territory coverage (WORLD or an exact match)", () => {
    fc.assert(
      fc.property(assetArb, contextArb, (asset, context) => {
        const result = assetAllowed(asset, context);
        const covered =
          asset.territory.includes("WORLD") || asset.territory.includes(context.territory);
        if (!covered) {
          expect(result.allowed).toBe(false);
          expect(result.reasons).toContain("territory-not-covered");
        }
      }),
    );
  });

  it("respects term windows", () => {
    fc.assert(
      fc.property(assetArb, contextArb, (asset, context) => {
        const result = assetAllowed(asset, context);
        const at = new Date();
        if (asset.termStart !== null && asset.termStart > at) {
          expect(result.reasons).toContain("term-not-started");
        }
        if (asset.termEnd !== null && asset.termEnd < at) {
          expect(result.reasons).toContain("term-expired");
        }
      }),
    );
  });

  it("is a pure function: same input always yields the same result", () => {
    fc.assert(
      fc.property(assetArb, contextArb, (asset, context) => {
        const a = assetAllowed(asset, context);
        const b = assetAllowed(asset, context);
        expect(a).toEqual(b);
      }),
    );
  });

  it("an owned, world-territory, no-term asset on cloud_render at any plan is always allowed", () => {
    const asset: AssetAllowedInput = {
      provider: "owned",
      territory: ["WORLD"],
      termStart: null,
      termEnd: null,
      allowsRawFileDelivery: true,
      clearanceMethod: "none",
    };
    for (const plan of plans) {
      for (const surface of surfaces) {
        expect(assetAllowed(asset, { surface, plan, territory: "IN" }).allowed).toBe(true);
      }
    }
  });
});
