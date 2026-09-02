import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

/**
 * A backend package, not a layout one: `docs/CONTRACTS.md` §9 sets no threshold
 * for it, so it takes the app tier (75/70) — most of what is left uncovered is
 * the browser-only surface creation, which the Playwright lane exercises.
 */
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig({
      test: {
        name: "@montaj/render-canvaskit",
        testTimeout: 30_000,
        coverage: {
          exclude: [
            "**/dist/**",
            "**/*.test.ts",
            "**/*.config.*",
            "**/index.ts",
            "e2e/**",
            "scripts/**",
            "src/frames.ts",
          ],
        },
      },
    }),
  ),
  defineConfig(coverageThresholds({ lines: 75, branches: 70, functions: 75, statements: 75 })),
);
