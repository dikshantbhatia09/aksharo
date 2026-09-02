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
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = {
        ...(config.resolve.fallback as Record<string, false | string> | undefined),
        fs: false,
        path: false,
        module: false,
        crypto: false,
      };
    }
    return config;
  },
};

export default nextConfig;
