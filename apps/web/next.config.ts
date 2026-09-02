import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
