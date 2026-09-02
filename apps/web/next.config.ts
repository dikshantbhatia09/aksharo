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
};

export default nextConfig;
