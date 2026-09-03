import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

/**
 * X01 threat-model audit: neither `next.config.ts` nor `middleware.ts` set
 * any security response headers before this change. This test locks in the
 * fix so a future edit cannot silently drop CSP/HSTS/frame-ancestors again.
 */
describe("next.config security headers", () => {
  it("declares a headers() function", () => {
    expect(typeof nextConfig.headers).toBe("function");
  });

  it("applies CSP, HSTS, frame-ancestors and referrer-policy to every route", async () => {
    const headerRules = await nextConfig.headers!();
    expect(headerRules).toHaveLength(1);
    const rule = headerRules[0]!;
    expect(rule.source).toBe("/:path*");

    const byKey = Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
    expect(byKey["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(byKey["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(byKey["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(byKey["Strict-Transport-Security"]).toContain("max-age=15552000");
    expect(byKey["Strict-Transport-Security"]).toContain("includeSubDomains");
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });
});

/** X03: `/developers` (B14) is subsumed into the single `/docs` surface. */
describe("next.config docs redirects", () => {
  it("redirects /developers to /docs/developers permanently", async () => {
    const rules = await nextConfig.redirects!();
    const rule = rules.find((r) => r.source === "/developers");
    expect(rule).toBeDefined();
    expect(rule!.destination).toBe("/docs/developers");
    expect(rule!.permanent).toBe(true);
  });
});
