import { describe, expect, it } from "vitest";

import { CHANGELOG_ENTRIES } from "@/content/site/changelog";
import { COMPARISON_PAGES, comparisonBySlug } from "@/content/site/comparisons";
import { DEMO_DURATION_MS, DEMO_STYLE_IDS, DEMO_WORDS } from "@/content/site/demo-transcript";
import { detectPlatform, PLATFORM_BUILDS } from "@/content/site/download-data";
import { formatIcuLite, heroCopy } from "@/content/site/hero-copy";
import { DRAFT_BANNER, GRIEVANCE_OFFICER, LEGAL_DOCS } from "@/content/site/legal";
import { FOOTER_LEGAL_NAV, PRIMARY_NAV } from "@/content/site/nav";
import { ACTIVATION_STEPS, HOST_SURFACES } from "@/content/site/plugins-data";
import {
  formatPrice,
  minorToUnit,
  FALLBACK_PLAN_CATALOGUE,
  PLAN_MATRIX,
  planByKey,
} from "@/content/site/pricing-data";
import { OUR_OBJECTIONS, PAUSE_OBJECTIONS } from "@/content/site/pricing-faq";
import { mergeLivePlans } from "@/content/site/pricing-live";

/**
 * The content layer is data, not UI — Playwright proves it renders correctly
 * (`e2e/*.spec.ts`); this suite proves the data itself is internally
 * consistent, so a typo here fails fast in `pnpm --filter @montaj/web test`
 * rather than only showing up as a wrong-looking page.
 */

const ALL_STRING_VALUES: string[] = [];
function collectStrings(value: unknown): void {
  if (typeof value === "string") {
    ALL_STRING_VALUES.push(value);
  } else if (Array.isArray(value)) {
    value.forEach(collectStrings);
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach(collectStrings);
  }
}
[
  CHANGELOG_ENTRIES,
  COMPARISON_PAGES,
  DEMO_WORDS,
  DEMO_STYLE_IDS,
  PLATFORM_BUILDS,
  LEGAL_DOCS,
  GRIEVANCE_OFFICER,
  PRIMARY_NAV,
  FOOTER_LEGAL_NAV,
  OUR_OBJECTIONS,
  PAUSE_OBJECTIONS,
  FALLBACK_PLAN_CATALOGUE,
  PLAN_MATRIX,
  HOST_SURFACES,
  ACTIVATION_STEPS,
  heroCopy("en"),
  heroCopy("hi"),
].forEach(collectStrings);

describe("codename guard (content layer)", () => {
  it("never renders the internal engineering codename in any marketing string", () => {
    const offenders = ALL_STRING_VALUES.filter((value) => value.toLowerCase().includes("montaj"));
    expect(offenders).toEqual([]);
  });
});

describe("pricing-data", () => {
  it("formats minor units into a display price", () => {
    expect(formatPrice(69_900, "INR")).toBe("₹699");
    expect(formatPrice(1_900, "USD")).toBe("$19");
    expect(minorToUnit(69_900)).toBe(699);
  });

  it("looks plans up by key and throws on an unknown one", () => {
    expect(planByKey("creator").name).toBe("Creator");
    expect(() => planByKey("bogus" as never)).toThrow();
  });

  it("carries exactly one Studio yearly halfyear price for the 15,000 UPI cap", () => {
    const studio = planByKey("studio");
    expect(studio.prices.INR.halfyear).toBe(999_600);
    expect(studio.prices.INR.halfyear).toBeLessThan(1_500_000);
  });

  it("gives every plan in PLAN_MATRIX a value, for every plan key", () => {
    for (const row of PLAN_MATRIX) {
      for (const plan of FALLBACK_PLAN_CATALOGUE) {
        expect(row.values[plan.key], `${row.label} / ${plan.key}`).toBeDefined();
      }
    }
  });

  it("marks exactly one plan as most popular", () => {
    expect(FALLBACK_PLAN_CATALOGUE.filter((plan) => plan.mostPopular)).toHaveLength(1);
  });
});

describe("pricing-live: mergeLivePlans", () => {
  const apiPlans = FALLBACK_PLAN_CATALOGUE.map((plan) => ({
    key: plan.key,
    name: `API ${plan.name}`,
    prices: {
      INR: { ...plan.prices.INR },
      USD: { ...plan.prices.USD },
    },
    creditsPerMonthTenths: plan.creditsPerMonth * 10,
    seatPrice: plan.seatPrice,
    hasHalfyear: {
      INR: plan.prices.INR.halfyear !== undefined,
      USD: plan.prices.USD.halfyear !== undefined,
    },
  }));

  it("merges the API's numbers onto this file's marketing copy, in ladder order", () => {
    const merged = mergeLivePlans(apiPlans);
    expect(merged.map((plan) => plan.key)).toEqual(FALLBACK_PLAN_CATALOGUE.map((plan) => plan.key));
    for (const [index, plan] of merged.entries()) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const fallback = FALLBACK_PLAN_CATALOGUE[index]!;
      // The name comes from the API (it could change independently of this
      // file); the marketing copy comes from the fallback, because the API
      // does not carry it.
      expect(plan.name).toBe(`API ${fallback.name}`);
      expect(plan.tagline).toBe(fallback.tagline);
      expect(plan.highlights).toEqual(fallback.highlights);
      expect(plan.mostPopular).toBe(fallback.mostPopular);
      expect(plan.creditsPerMonth).toBe(fallback.creditsPerMonth);
      expect(plan.prices).toEqual(fallback.prices);
    }
  });

  it("drops a plan the API returns that this page has no marketing copy for", () => {
    const merged = mergeLivePlans([
      ...apiPlans,
      {
        key: "unknown-future-plan" as (typeof apiPlans)[number]["key"],
        name: "Mystery",
        prices: { INR: { month: 1, year: 1 }, USD: { month: 1, year: 1 } },
        creditsPerMonthTenths: 10,
        seatPrice: null,
        hasHalfyear: { INR: false, USD: false },
      },
    ]);
    expect(merged.map((plan) => plan.key)).toEqual(FALLBACK_PLAN_CATALOGUE.map((plan) => plan.key));
  });
});

describe("comparisons", () => {
  it("gives every comparison page a dated, attributable source for every fact", () => {
    for (const page of COMPARISON_PAGES) {
      expect(page.sourceLabel.length).toBeGreaterThan(0);
      expect(page.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(page.facts.length).toBeGreaterThan(0);
      for (const fact of page.facts) {
        expect(fact.label.length).toBeGreaterThan(0);
        expect(fact.them.length).toBeGreaterThan(0);
        expect(fact.us.length).toBeGreaterThan(0);
      }
    }
  });

  it("covers exactly the four competitors the brief names", () => {
    const slugs = COMPARISON_PAGES.map((page) => page.slug).sort();
    expect(slugs).toEqual(["autocut", "captik", "kalakar", "submagic"]);
  });

  it("resolves a known slug and returns undefined for an unknown one", () => {
    expect(comparisonBySlug("kalakar")?.competitorName).toBe("Kalakar");
    expect(comparisonBySlug("not-a-competitor")).toBeUndefined();
  });
});

describe("hero-copy", () => {
  it("substitutes a simple ICU argument", () => {
    expect(formatIcuLite("Hello {name}", { name: "World" })).toBe("Hello World");
    expect(formatIcuLite("No args here", {})).toBe("No args here");
  });

  it("gives English and Hindi the same number of subheads", () => {
    expect(heroCopy("en").subheads).toHaveLength(heroCopy("hi").subheads.length);
  });

  it("interpolates the brand name into the kicker", () => {
    expect(heroCopy("en").kicker).toContain("Aksharo");
  });
});

describe("demo-transcript", () => {
  it("keeps every word inside the 15 s cue, in speaking order", () => {
    for (const word of DEMO_WORDS) {
      expect(word.s).toBeGreaterThanOrEqual(0);
      expect(word.e).toBeLessThanOrEqual(DEMO_DURATION_MS);
      expect(word.e).toBeGreaterThan(word.s);
    }
    for (let index = 1; index < DEMO_WORDS.length; index += 1) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      expect(DEMO_WORDS[index]!.s).toBeGreaterThanOrEqual(DEMO_WORDS[index - 1]!.e);
    }
  });

  it("puts punch-pop first in the style switcher", () => {
    expect(DEMO_STYLE_IDS[0]).toBe("punch-pop");
  });
});

describe("plugins-data (D65 naming)", () => {
  it("uses the exact compliant product names", () => {
    const premiere = HOST_SURFACES.find((entry) => entry.id === "premiere-ae");
    const resolve = HOST_SURFACES.find((entry) => entry.id === "resolve");
    expect(premiere?.productName).toBe(
      "Aksharo Panel — works with Adobe Premiere Pro and Adobe After Effects",
    );
    expect(resolve?.productName).toBe("Aksharo — works with DaVinci Resolve");
  });
});

describe("legal", () => {
  it("every legal doc has at least one section with a non-empty body", () => {
    for (const doc of LEGAL_DOCS) {
      expect(doc.sections.length).toBeGreaterThan(0);
      for (const section of doc.sections) {
        expect(section.body.length).toBeGreaterThan(0);
      }
    }
  });

  it("the draft banner explicitly says pending counsel", () => {
    expect(DRAFT_BANNER).toContain("pending counsel");
  });

  it("the grievance officer publishes the IT Rules response windows", () => {
    expect(GRIEVANCE_OFFICER.takedownCourtOrGovernmentHours).toBe(3);
    expect(GRIEVANCE_OFFICER.takedownIndividualComplaintHours).toBe(36);
  });
});

describe("download-data", () => {
  it("detects a platform from a user agent string", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)")).toBe("macos");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14)")).toBe("unknown");
  });

  it("has a build entry for every platform it claims to detect", () => {
    expect(PLATFORM_BUILDS.map((build) => build.platform).sort()).toEqual([
      "linux",
      "macos",
      "windows",
    ]);
  });
});
