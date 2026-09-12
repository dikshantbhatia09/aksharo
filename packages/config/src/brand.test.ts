import { describe, expect, it } from "vitest";

import { BRAND, CODENAME, PLUGIN_IDS, brandUrl, deepLink } from "./brand.js";

describe("BRAND", () => {
  it("carries the Kalakar brand from CONTRACTS §0", () => {
    expect(BRAND).toEqual({
      name: "Kalakar",
      domain: "kalakar.io",
      altDomain: "app.kalakar.io",
      deepLinkScheme: "kalakar",
      supportEmail: "support@kalakar.io",
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
});

describe("brandUrl", () => {
  it("builds absolute https URLs on the brand domain", () => {
    expect(brandUrl()).toBe("https://kalakar.io/");
    expect(brandUrl("/pricing")).toBe("https://kalakar.io/pricing");
  });
});

describe("deepLink", () => {
  it("uses the brand scheme and tolerates leading slashes", () => {
    expect(deepLink("project/01J")).toBe("kalakar://project/01J");
    expect(deepLink("/project/01J")).toBe("kalakar://project/01J");
  });
});
