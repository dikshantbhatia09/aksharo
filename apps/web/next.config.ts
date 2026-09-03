import type { NextConfig } from "next";

/**
 * Security response headers (X01 threat-model audit gap: neither this file
 * nor `middleware.ts` set any before this change). Applied to every route via
 * `headers()` rather than per-response in middleware so they cannot be
 * skipped by a route that never runs the middleware chain.
 *
 * CSP is deliberately permissive on `script-src`/`style-src` (`'self'` plus
 * `'unsafe-inline'`) rather than nonce-based: Next.js inlines hydration data
 * and this app has no nonce plumbing yet. It still blocks the concrete
 * threats in scope — framing (`frame-ancestors 'none'`, T25 desktop shell
 * excluded since Electron loads its own origin allowlist, not this header),
 * mixed content, and any object/base-uri injection. Tightening to nonces is
 * a follow-up (see docs/security/threat-model-audit).
 *
 * `connect-src`'s `https:` keyword only matches TLS origins, so it never
 * covered a plain-`http://` API — the case for every local dev server and
 * every Playwright run, which each work package points at its own
 * `http://127.0.0.1:<port>`. Without the API's actual origin listed
 * explicitly, the browser blocks the sign-up/login/etc. `fetch()` calls
 * outright (silently — no network entry, just a CSP console error), which
 * made every authenticated e2e spec hang at the shared sign-up helper
 * waiting for a response that was never sent. `API_ORIGIN` is read here at
 * server start (same env var `lib/runtime-config.ts` hands the browser), so
 * production's `https://api...` origin is allowed alongside dev/e2e's `http`
 * one — no wildcard scheme needed for either case.
 */
const API_ORIGIN = process.env["API_ORIGIN"]?.trim() ?? "";

const SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "font-src 'self' data:",
      ["connect-src 'self' https: wss:", API_ORIGIN].filter(Boolean).join(" "),
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ].join("; "),
  },
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  /**
   * X03: `/docs` is now the one docs surface (guides, plugin guides,
   * developer API reference, legal) rather than a separate site. `/developers`
   * (B14) is subsumed by `/docs/developers` — a permanent redirect keeps every
   * inbound link and bookmark to the old URL working, per the brief's
   * "redirects: ... /developers keep working (redirect or alias)", while the
   * expanded reference (per-endpoint pages, generated from the OpenAPI
   * document) lives at the new address. `(app)/help` is a separate,
   * authenticated in-product surface (B12) and is unaffected — it keeps its
   * own URLs; `/docs/guides` reuses the same MDX as a second, public entry
   * point rather than replacing it.
   */
  async redirects() {
    return [{ source: "/developers", destination: "/docs/developers", permanent: true }];
  },
  reactStrictMode: true,
  // Lint runs as its own turbo task with the shared flat config, so the build
  // must not run a second, differently-configured pass.
  eslint: { ignoreDuringBuilds: true },
  // Type errors still fail the build.
  typescript: { ignoreBuildErrors: false },
  poweredByHeader: false,
  // Playwright drives the dev server over 127.0.0.1; without this Next warns on
  // every `/_next/*` request and will reject them in a future major version.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Both are compiled with the app rather than externalised. `@montaj/ui` ships
  // TypeScript source with "use client" boundaries; `@montaj/api-client` would
  // otherwise be required as CommonJS on the server while the app imports the ESM
  // build of TanStack Query, which makes two QueryClient contexts and one very
  // confusing runtime error.
  transpilePackages: ["@montaj/ui", "@montaj/api-client"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
    // M07: documented safety net, not the fix. The real fix was an actual bug
    // — `lib/docs/markdown.tsx`'s `toBlocks()` looped forever (never
    // advancing its line cursor) on any paragraph starting with bold text
    // (`**Status:** ...`, which every plugin README opens with), so
    // `/docs/plugins/[slug]` allocated paragraph blocks in an infinite loop
    // until the static-generation worker hit the JS heap ceiling. Fixed at
    // the source (see that file). `lib/docs/openapi.ts` / `lib/docs/content.ts`
    // also used to recompute the OpenAPI groups and the MiniSearch index on
    // every `/docs/**` page instead of once per worker — real waste, memoised
    // now, but not itself the crash. `cpus: 1` + `webpackMemoryOptimizations`
    // are kept as a documented safety margin on this shared, memory-constrained
    // build host, not as a substitute for the fix above.
    cpus: 1,
    webpackMemoryOptimizations: true,
  },
  /**
   * CanvasKit and HarfBuzz are emscripten builds that sniff their environment at
   * load time: both reference `fs` (and HarfBuzz `module`) inside a
   * `typeof process === "object"` branch that never runs in a browser. Webpack
   * still has to resolve the specifier, so the Node built-ins are stubbed out
   * for the client bundle only — the server bundle keeps the real ones, which is
   * what lets a route read the style catalogue off disk.
   */
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = {
        ...(config.resolve.fallback as Record<string, false | string> | undefined),
        fs: false,
        path: false,
        module: false,
        crypto: false,
      };
      // `@montaj/render-manifest`'s HMAC signing/verification (`node:crypto`) is
      // server-only; the browser exporter (A19) only imports the package's
      // schema and cap-checking helpers, never `signRenderManifest`/
      // `verifyManifestSignature`, but ES module evaluation still touches the
      // whole barrel file at load time. The bare `crypto` fallback above does
      // not cover the `node:` URI scheme (webpack 5 treats it as a distinct
      // scheme, not a bare specifier to resolve), so it needs its own alias.
      // Reported as a deviation in the final report: an isomorphic split of
      // `@montaj/render-manifest` (schema/caps vs. signing) would let a browser
      // bundle avoid pulling this in at all.
      //
      // Neither `resolve.fallback` nor `resolve.alias` intercepts a `node:`
      // specifier: webpack 5 treats `node:` as a URI *scheme*, resolved before
      // normal module resolution runs, so it fails with `UnhandledSchemeError`
      // even with `"node:crypto": false` aliased. Rewriting the specifier to
      // its bare form first is what lets the existing `crypto: false` fallback
      // apply.
      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
    }
    return config;
  },
};

export default nextConfig;
