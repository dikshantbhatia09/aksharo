import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    // CONTRACTS §9: `apps/web` is 60/50.
    defineConfig(coverageThresholds({ lines: 60, branches: 50 })),
  ),
  defineConfig({
    // Vitest transforms TSX with esbuild, which reads `jsx` from tsconfig — and
    // Next sets `preserve` there because SWC does the transform. Tests need a
    // real one.
    esbuild: { jsx: "automatic" },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL(".", import.meta.url)),
        "server-only": fileURLToPath(new URL("./test/empty-module.ts", import.meta.url)),
      },
    },
    test: {
      name: "@montaj/web",
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      // `e2e/` belongs to Playwright, not Vitest.
      include: [
        "lib/**/*.{test,spec}.{ts,tsx}",
        "components/**/*.{test,spec}.{ts,tsx}",
        "app/**/*.{test,spec}.{ts,tsx}",
        "middleware.test.ts",
      ],
      coverage: {
        /*
         * Routes live under `app/` and are covered by the Playwright suite —
         * signup through onboarding, device approval, consent persistence, and
         * an axe pass on every screen — which Vitest cannot see. Measuring them
         * here would report zero for code that is in fact tested, so the gate is
         * set over the logic Vitest actually runs: the client libraries, the
         * shell components and the middleware.
         */
        include: ["lib/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "middleware.ts"],
        exclude: ["**/*.test.{ts,tsx}", "lib/version.ts"],
      },
    },
  }),
);
