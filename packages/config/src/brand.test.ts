import { describe, expect, it } from "vitest";

import {
  BRAND,
  CODENAME,
  FORBIDDEN_BRAND_NAMES,
  PLUGIN_IDS,
  brandUrl,
  deepLink,
} from "./brand.js";

describe("BRAND", () => {
  it("carries the Aksharo brand from CONTRACTS §0 (decision D59)", () => {
    expect(BRAND).toEqual({
      name: "Aksharo",
      domain: "aksharo.ai",
      altDomain: "aksharo.in",
      deepLinkScheme: "aksharo",
      supportEmail: "support@aksharo.ai",
    });
  });

  it("keeps the engineering codename out of every user-facing string", () => {
    const userFacing = [
      BRAND.name,
      BRAND.domain,
      BRAND.altDomain,
      BRAND.deepLinkScheme,
      BRAND.supportEmail,
      ...Object.values(PLUGIN_IDS),
    ];
    for (const value of userFacing) {
      expect(value.toLowerCase()).not.toContain(CODENAME);
    }
  });

  /**
   * The regression this guards against actually shipped to `main`: the
   * visual-parity pass copied a competitor's brand into this file, so the
   * product's canonical name, domain, support address and desktop deep-link
   * scheme all became theirs. Nothing else in the repo would have failed.
   */
  it("never carries another company's product name", () => {
    const userFacing = [
      BRAND.name,
      BRAND.domain,
      BRAND.altDomain,
      BRAND.deepLinkScheme,
      BRAND.supportEmail,
      ...Object.values(PLUGIN_IDS),
    ];
    for (const forbidden of FORBIDDEN_BRAND_NAMES) {
      for (const value of userFacing) {
        expect(
          value.toLowerCase(),
          `"${value}" must not contain the non-brand name "${forbidden}"`,
        ).not.toContain(forbidden);
      }
    }
  });
});

describe("brandUrl", () => {
  it("builds absolute https URLs on the brand domain", () => {
    expect(brandUrl()).toBe("https://aksharo.ai/");
    expect(brandUrl("/pricing")).toBe("https://aksharo.ai/pricing");
  });
});

describe("deepLink", () => {
  it("uses the brand scheme and tolerates leading slashes", () => {
    expect(deepLink("project/01J")).toBe("aksharo://project/01J");
    expect(deepLink("/project/01J")).toBe("aksharo://project/01J");
  });
});
