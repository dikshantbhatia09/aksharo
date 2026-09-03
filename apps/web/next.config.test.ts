import { afterEach, describe, expect, it, vi } from "vitest";

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

  /**
   * M09: `connect-src`'s `https:` keyword never matched a plain-`http://` API
   * origin, which every local dev server and Playwright run uses. That blocked
   * the sign-up/login/etc. `fetch()` calls outright and made every
   * authenticated e2e spec hang at the shared sign-up helper. `API_ORIGIN` must
   * be listed explicitly so its scheme (http or https) does not matter.
   */
  it("allows fetches to API_ORIGIN even when it is a plain http:// origin", async () => {
    vi.resetModules();
    vi.stubEnv("API_ORIGIN", "http://127.0.0.1:3950");
    const { default: freshConfig } = await import("./next.config");
    const headerRules = await freshConfig.headers!();
    const byKey = Object.fromEntries(headerRules[0]!.headers.map((h) => [h.key, h.value]));
    expect(byKey["Content-Security-Policy"]).toContain("connect-src 'self' https: wss:");
    expect(byKey["Content-Security-Policy"]).toContain("http://127.0.0.1:3950");
  });

  /**
   * M10: the same gap M09 fixed for plain `fetch()`, but for the realtime
   * websocket — `wss:` in `connect-src` does not cover a plain `ws://` dial,
   * which every local dev server and Playwright run uses (A15's realtime
   * client). Chrome logged "Connecting to 'ws://...' violates ... connect-src"
   * and blocked it outright.
   */
  it("allows a plain ws:// realtime socket to API_ORIGIN's host", async () => {
    vi.resetModules();
    vi.stubEnv("API_ORIGIN", "http://127.0.0.1:3950");
    const { default: freshConfig } = await import("./next.config");
    const headerRules = await freshConfig.headers!();
    const byKey = Object.fromEntries(headerRules[0]!.headers.map((h) => [h.key, h.value]));
    expect(byKey["Content-Security-Policy"]).toContain("ws://127.0.0.1:3950");
  });

  /**
   * M10: `script-src 'self' 'unsafe-inline'` alone blocks
   * `WebAssembly.instantiate` — Chrome reports it as a `script-src`
   * violation and aborts the compile — which meant CanvasKit (every editor
   * route's renderer, and what `/export-harness` waits on before it ever
   * marks itself ready) never initialised under this CSP, silently hanging
   * `export.spec.ts`'s `page.waitForFunction(... ready === true)` for its
   * full 60s regardless of the host's throughput. `'wasm-unsafe-eval'` is
   * the CSP3 keyword scoped to wasm compilation, not the broader
   * `'unsafe-eval'` (which would also permit plain JS `eval`).
   */
  it("allows WebAssembly compilation via 'wasm-unsafe-eval' without the broader 'unsafe-eval'", async () => {
    const headerRules = await nextConfig.headers!();
    const byKey = Object.fromEntries(headerRules[0]!.headers.map((h) => [h.key, h.value]));
    expect(byKey["Content-Security-Policy"]).toContain("'wasm-unsafe-eval'");
    expect(byKey["Content-Security-Policy"]).not.toMatch(/(?<!wasm-)'unsafe-eval'/);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
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
