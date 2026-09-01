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
    // Workspace packages are plain CommonJS builds; nothing to transpile yet.
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
