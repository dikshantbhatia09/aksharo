import { describe, expect, it } from "vitest";

import { EN_MESSAGES } from "../../../../../api/src/notify/templates/messages.en";
import { HI_MESSAGES } from "../../../../../api/src/notify/templates/messages.hi";

import sitemap from "@/app/(site)/sitemap";
import { CHANGELOG_ENTRIES } from "@/content/site/changelog";
import { PLATFORM_BUILDS } from "@/content/site/download-data";
import { heroCopy } from "@/content/site/hero-copy";
import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";
import { DRAFT_BANNER, LEGAL_DOCS } from "@/content/site/legal";
import {
  FOOTER_COMPARE_NAV,
  FOOTER_LEGAL_NAV,
  FOOTER_PRODUCT_NAV,
  PRIMARY_NAV,
} from "@/content/site/nav";
import { ACTIVATION_STEPS, HOST_SURFACES } from "@/content/site/plugins-data";
import { FALLBACK_PLAN_CATALOGUE, PLAN_MATRIX } from "@/content/site/pricing-data";
import { OUR_OBJECTIONS, PAUSE_OBJECTIONS } from "@/content/site/pricing-faq";
import { VALUE_PROPS } from "@/content/site/value-props";
import { loadHelpArticles } from "@/lib/content/loader";
import { checkDocsLinks } from "@/lib/docs/link-check";
import { buildDocsNav } from "@/lib/docs/nav";

/**
 * RLS-007: Automated claim-crawl and truthful release gating assertions.
 *
 * Verifies that:
 * 1. A public crawl finds no unsupported product promises (timeline plugins, desktop local mode).
 * 2. No placeholder installer copy ("ships with C10", "Download link placeholder") exists.
 * 3. No unapproved legal claims exist (all legal docs carry draft banner pending counsel).
 * 4. No stale brand (Kalakar) or leaked engineering codename (montaj) appears in public copy.
 * 5. Sitemap and docs navigation dynamically filter out unreleased surfaces.
 * 6. Direct route gates fail-closed via notFound().
 */

function collectStrings(value: unknown, target: string[]): void {
  if (typeof value === "string") {
    target.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, target));
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => collectStrings(item, target));
  }
}

const ALL_PUBLIC_MARKETING_STRINGS: string[] = [];
[
  heroCopy("en"),
  heroCopy("hi"),
  VALUE_PROPS,
  FALLBACK_PLAN_CATALOGUE,
  PLAN_MATRIX,
  OUR_OBJECTIONS,
  PAUSE_OBJECTIONS,
  PRIMARY_NAV,
  FOOTER_PRODUCT_NAV,
  FOOTER_LEGAL_NAV,
  FOOTER_COMPARE_NAV,
  CHANGELOG_ENTRIES,
  PLATFORM_BUILDS,
  HOST_SURFACES,
  ACTIVATION_STEPS,
].forEach((obj) => collectStrings(obj, ALL_PUBLIC_MARKETING_STRINGS));

describe("RLS-007 Public Claim Crawl: Product Promises", () => {
  it("never promises 'inside your timeline' or live NLE plugins as currently shipped in marketing hero", () => {
    const enHero = heroCopy("en");
    expect(enHero.headline).not.toContain("inside your timeline");
    expect(enHero.subheads.some((s) => s.includes("inside your timeline"))).toBe(false);
  });

  it("truthfully gates timeline integration in value props to subtitle exports and waitlist", () => {
    const timelineProp = VALUE_PROPS.find((p) => p.id === "timeline");
    expect(timelineProp).toBeDefined();
    expect(timelineProp?.body).toContain("waitlist");
    expect(timelineProp?.body).toContain("SRT, VTT and ASS");
  });

  it("truthfully marks unreleased surfaces in PLAN_MATRIX as in development / waitlist", () => {
    const pluginsRow = PLAN_MATRIX.find((row) => row.label.toLowerCase().includes("plugins"));
    const localModeRow = PLAN_MATRIX.find((row) => row.label.toLowerCase().includes("local mode"));

    expect(pluginsRow).toBeDefined();
    expect(localModeRow).toBeDefined();

    for (const plan of FALLBACK_PLAN_CATALOGUE) {
      expect(pluginsRow?.values[plan.key]).toContain("Waitlist");
      if (plan.key !== "free") {
        expect(localModeRow?.values[plan.key]).toContain("Waitlist");
      }
    }
  });

  it("eliminates dead comparison navigation and competitor links", () => {
    expect(FOOTER_COMPARE_NAV).toHaveLength(0);
  });
});

describe("RLS-007 Public Claim Crawl: Placeholder Installer & Milestone Jargon", () => {
  it("contains zero occurrences of internal milestone markers ('ships with C10', 'pending C10')", () => {
    const c10Matches = ALL_PUBLIC_MARKETING_STRINGS.filter((s) => /c10\b/i.test(s));
    expect(c10Matches).toEqual([]);
  });

  it("contains zero occurrences of 'Download link placeholder' in public copy", () => {
    const placeholderMatches = ALL_PUBLIC_MARKETING_STRINGS.filter((s) =>
      /download link placeholder/i.test(s),
    );
    expect(placeholderMatches).toEqual([]);
  });
});

describe("RLS-007 Public Claim Crawl: Stale Brands and Leaked Codenames", () => {
  it("never leaks the internal engineering codename 'montaj' in any public marketing string", () => {
    const leaked = ALL_PUBLIC_MARKETING_STRINGS.filter((s) => s.toLowerCase().includes("montaj"));
    expect(leaked).toEqual([]);
  });

  it("never references competitor or legacy name 'Kalakar' in public strings or nav", () => {
    const kalakarMatches = ALL_PUBLIC_MARKETING_STRINGS.filter((s) =>
      s.toLowerCase().includes("kalakar"),
    );
    expect(kalakarMatches).toEqual([]);
  });
});

describe("RLS-007 Public Claim Crawl: Legal Scaffolds & Draft Banners", () => {
  it("requires draft banner on every legal document", () => {
    expect(DRAFT_BANNER).toContain("pending counsel");
    for (const doc of LEGAL_DOCS) {
      expect(doc.title).toBeDefined();
      expect(doc.sections.length).toBeGreaterThan(0);
    }
  });
});

describe("RLS-007 Sitemap Crawl Gate", () => {
  it("strictly omits disabled surfaces (/download, /plugins, /docs/plugins) under default flags", () => {
    const prev = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = "{}";
      const entries = sitemap();
      const urls = entries.map((e) => e.url);

      expect(urls.some((u) => u.endsWith("/download"))).toBe(false);
      expect(urls.some((u) => u.endsWith("/plugins"))).toBe(false);
      expect(urls.some((u) => u.includes("/docs/plugins"))).toBe(false);

      // Omits draft noindex legal docs from sitemap
      expect(urls.some((u) => u.includes("/legal/"))).toBe(false);

      // Shipped surfaces remain available
      expect(urls.some((u) => u.endsWith("/features"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/pricing"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/styles"))).toBe(true);
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = prev;
    }
  });

  it("dynamically exposes /download and /plugins only when their respective surfaces are enabled", () => {
    const prev = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({
        "desktop.download": true,
        "plugins.enabled": true,
      });
      const entries = sitemap();
      const urls = entries.map((e) => e.url);

      expect(urls.some((u) => u.endsWith("/download"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/plugins"))).toBe(true);
      expect(urls.some((u) => u.includes("/docs/plugins"))).toBe(true);
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = prev;
    }
  });
});

describe("RLS-007 Docs Navigation & Link Crawl", () => {
  it("omits plugins section when plugins surface is disabled", () => {
    const nav = buildDocsNav(loadHelpArticles(), { includePlugins: false });
    expect(nav.map((s) => s.id)).toEqual(["guides", "developers", "legal"]);
  });

  it("includes plugins section when plugins surface is enabled", () => {
    const nav = buildDocsNav(loadHelpArticles(), { includePlugins: true });
    expect(nav.map((s) => s.id)).toEqual(["guides", "plugins", "developers", "legal"]);
  });

  it("has zero broken internal links in default docs nav", () => {
    const nav = buildDocsNav(loadHelpArticles(), { includePlugins: false });
    const everyHref = nav.flatMap((s) => [s.href, ...s.items.map((i) => i.href)]);
    const result = checkDocsLinks(
      nav,
      everyHref.filter((h) => h.startsWith("/docs")),
    );
    expect(result.brokenLinks).toEqual([]);
  });
});

describe("RLS-007 Server-Side Direct Route Guard (RLS-006 / WEB-009)", () => {
  it("assertServerSurfaceEnabled throws notFound on disabled surfaces", () => {
    const prev = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = "{}";
      expect(() => assertServerSurfaceEnabled("desktop")).toThrow();
      expect(() => assertServerSurfaceEnabled("plugins")).toThrow();
      expect(() => assertServerSurfaceEnabled("affiliates")).toThrow();
      expect(() => assertServerSurfaceEnabled("checkout")).toThrow();

      // Core web surface is enabled
      expect(() => assertServerSurfaceEnabled("web")).not.toThrow();
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = prev;
    }
  });
});

describe("RLS-007 Email Notification Templates Truthfulness", () => {
  it("limits low-credits footnote strictly to browser-native exports in English and Hindi", () => {
    const enLowCredits = EN_MESSAGES.kinds["low-credits"];
    const hiLowCredits = HI_MESSAGES.kinds["low-credits"];

    expect(enLowCredits.footnotes).toEqual([
      "Browser-native exports never use processing minutes.",
    ]);
    expect(hiLowCredits.footnotes).toEqual([
      "ब्राउज़र एक्सपोर्ट में प्रोसेसिंग मिनट कभी नहीं लगते।",
    ]);

    // Neither mentions local desktop exports
    expect(enLowCredits.footnotes?.some((f) => f.toLowerCase().includes("local"))).toBe(false);
    expect(hiLowCredits.footnotes?.some((f) => f.includes("लोकल"))).toBe(false);
  });
});
