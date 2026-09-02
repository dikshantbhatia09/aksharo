import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

/**
 * `docs/CONTRACTS.md` §9 puts `apps/web` at 60/50.
 *
 * Routes under `app/` are covered by the Playwright lane — sign-up through
 * onboarding, device approval, consent persistence, the style preview, and an
 * axe pass on every screen — which Vitest cannot see. Measuring them here would
 * report zero for code that is in fact tested, so the gate is set over the logic
 * Vitest actually runs: the client libraries, the shell and editor components,
 * and the middleware.
 */
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig({
      // Vitest transforms TSX with esbuild, which reads `jsx` from tsconfig —
      // and Next sets `preserve` there because SWC does the transform. Tests
      // need a real one.
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
          include: ["lib/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "middleware.ts"],
          // `use-canvaskit.ts` instantiates two wasm modules against a DOM; the
          // Playwright lane covers it, and a jsdom stand-in would only assert
          // that the mock was called.
          exclude: [
            "**/*.test.{ts,tsx}",
            "**/index.ts",
            "lib/version.ts",
            // A16 covers the editor's React components with its own Playwright
            // lane (`style-preview.spec.ts`) rather than with jsdom, because they
            // draw through CanvasKit. Their pure logic — `ops.ts`,
            // `system-styles.ts`, `stage-geometry.ts` — is measured here, and is
            // at 100%.
            "components/editor/**/*.tsx",
            // Two wasm modules against a DOM; a jsdom stand-in would only assert
            // that the mock was called.
            "components/editor/canvas/use-canvaskit.ts",
          ],
        },
      },
    }),
  ),
  defineConfig(coverageThresholds({ lines: 60, branches: 50, functions: 60, statements: 60 })),
);
