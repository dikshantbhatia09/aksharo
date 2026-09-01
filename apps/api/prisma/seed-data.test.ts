import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BURN_RATES, TENTHS_PER_CREDIT } from "@montaj/config";

import {
  FEATURE_FLAG_SEEDS,
  loadSystemStyles,
  operationsFor,
  PLAN_LADDER,
  PLAN_SEEDS,
  planMeets,
  seedUlid,
} from "./seed-data.js";

describe("seedUlid", () => {
  it("is a 26-character ULID", () => {
    expect(seedUlid("plan:free")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is stable across calls, which is what makes the seed idempotent", () => {
    expect(seedUlid("plan:free")).toBe(seedUlid("plan:free"));
  });

  it("is different for different names", () => {
    expect(seedUlid("plan:free")).not.toBe(seedUlid("plan:starter"));
  });
});

describe("planMeets", () => {
  it("is true for every plan when there is no minimum", () => {
    for (const plan of PLAN_LADDER) expect(planMeets(plan, null)).toBe(true);
  });

  it("compares by position on the ladder", () => {
    expect(planMeets("free", "creator")).toBe(false);
    expect(planMeets("creator", "creator")).toBe(true);
    expect(planMeets("studio", "creator")).toBe(true);
    expect(planMeets("agency", "studio")).toBe(true);
  });
});

describe("operationsFor", () => {
  it("derives the gate from the burn-rate table rather than restating it", () => {
    // 04 §Credits: audio clean is Creator+, SFX/music is Studio+.
    expect(operationsFor("free").transcription).toBe(true);
    expect(operationsFor("free").audioClean).toBe(false);
    expect(operationsFor("creator").audioClean).toBe(true);
    expect(operationsFor("creator").sfxMusicPass).toBe(false);
    expect(operationsFor("studio").sfxMusicPass).toBe(true);
  });

  it("covers every operation in the table", () => {
    expect(Object.keys(operationsFor("agency")).sort()).toEqual(Object.keys(BURN_RATES).sort());
  });
});

describe("PLAN_SEEDS", () => {
  it("has the five plans of 04 §Plans, in ladder order", () => {
    expect(PLAN_SEEDS.map((plan) => plan.key)).toEqual([...PLAN_LADDER]);
  });

  it("prices the ladder as printed, in minor units inclusive of GST", () => {
    const price = (key: string, currency: "INR" | "USD", term: "month" | "year") =>
      (
        PLAN_SEEDS.find((plan) => plan.key === key)?.prices as Record<
          string,
          Record<string, number>
        >
      )[currency]?.[term];

    expect(price("free", "INR", "month")).toBe(0);
    expect(price("starter", "INR", "month")).toBe(29_900);
    expect(price("creator", "INR", "month")).toBe(69_900);
    expect(price("studio", "INR", "month")).toBe(199_900);
    expect(price("agency", "INR", "month")).toBe(119_900);

    expect(price("creator", "USD", "month")).toBe(1_900);
    // 04: "Creator yearly (₹6,984)".
    expect(price("creator", "INR", "year")).toBe(698_400);
    // 04: "Studio yearly (₹19,992)".
    expect(price("studio", "INR", "year")).toBe(1_999_200);
    // 04: "Agency yearly per seat (₹11,988)".
    expect(price("agency", "INR", "year")).toBe(1_198_800);
  });

  it("sells Studio yearly as two half-yearly debits, because of the UPI cap", () => {
    const studio = PLAN_SEEDS.find((plan) => plan.key === "studio");
    const inr = (studio?.prices as Record<string, Record<string, number>>)["INR"];
    // ₹19,992 exceeds the ₹15,000 UPI mandate cap; ₹9,996 does not (04 §Yearly, D40).
    expect(inr?.["halfyear"]).toBe(999_600);
    expect(inr?.["halfyear"]).toBeLessThanOrEqual(1_500_000);
  });

  it("grants credits in tenths", () => {
    const credits = (key: string) =>
      PLAN_SEEDS.find((plan) => plan.key === key)?.creditsPerMonthTenths;
    expect(credits("free")).toBe(20 * TENTHS_PER_CREDIT);
    expect(credits("starter")).toBe(150 * TENTHS_PER_CREDIT);
    expect(credits("creator")).toBe(500 * TENTHS_PER_CREDIT);
    expect(credits("studio")).toBe(1_800 * TENTHS_PER_CREDIT);
    expect(credits("agency")).toBe(900 * TENTHS_PER_CREDIT);
  });

  it("carries the retention row of 04 §Plans into the entitlements", () => {
    const retention = (key: string) =>
      (PLAN_SEEDS.find((plan) => plan.key === key)?.entitlements as Record<string, number>)[
        "retentionDays"
      ];
    expect([
      retention("free"),
      retention("starter"),
      retention("creator"),
      retention("studio"),
    ]).toEqual([7, 30, 90, 365]);
  });

  it("watermarks only the free plan", () => {
    for (const plan of PLAN_SEEDS) {
      const watermark = (plan.entitlements as Record<string, string>)["watermark"];
      expect(watermark, plan.key).toBe(plan.key === "free" ? "after_first_clean_export" : "none");
    }
  });
});

describe("FEATURE_FLAG_SEEDS", () => {
  it("is exactly the four flags the brief names", () => {
    expect(FEATURE_FLAG_SEEDS.map((flag) => flag.key).sort()).toEqual([
      "local_mode",
      "partner_audio",
      "provider_bhashini",
      "streak_experiment",
    ]);
  });

  it("explains why each one exists", () => {
    for (const flag of FEATURE_FLAG_SEEDS) {
      expect(flag.description.length, flag.key).toBeGreaterThan(20);
    }
  });
});

describe("loadSystemStyles", () => {
  it("falls back to five placeholder styles when A02 has no fixtures", () => {
    // An empty temp directory stands in for a repo root without
    // `packages/caption-styles/styles`.
    const empty = mkdtempSync(join(tmpdir(), "montaj-styles-"));
    const { source, styles } = loadSystemStyles(empty);

    expect(source).toBe("fallback");
    expect(styles).toHaveLength(5);
    expect(styles.map((style) => style.key)).toEqual([
      "punch-pop",
      "hype-bold",
      "karaoke-fill",
      "word-pop",
      "minimal-lower-third",
    ]);
  });

  it("names styles after the look, never a person or a brand (F-305)", () => {
    const empty = mkdtempSync(join(tmpdir(), "montaj-styles-"));
    for (const style of loadSystemStyles(empty).styles) {
      expect(style.key).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("reads packages/caption-styles/styles/*.json when A02 has landed", () => {
    const root = mkdtempSync(join(tmpdir(), "montaj-repo-"));
    const dir = join(root, "packages", "caption-styles", "styles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "bubble.json"),
      JSON.stringify({
        key: "bubble",
        name: "Bubble",
        category: "playful",
        doc: { schemaVersion: 2 },
      }),
    );
    // A file that is the StyleDoc itself, with the key taken from the filename.
    writeFileSync(join(dir, "glow.json"), JSON.stringify({ schemaVersion: 2, typography: {} }));

    const { source, styles } = loadSystemStyles(root);

    expect(source).toBe("fixtures");
    expect(styles.map((style) => style.key)).toEqual(["bubble", "glow"]);
    expect(styles[0]?.name).toBe("Bubble");
    expect(styles[1]?.name).toBe("glow");
    expect(styles[1]?.doc).toMatchObject({ schemaVersion: 2 });
  });
});
