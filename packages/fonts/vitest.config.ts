import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

/**
 * `docs/CONTRACTS.md` §9 puts a package at 90/85; A18b adds `packages/fonts` at
 * the same numbers.
 *
 * The exclusions carry no logic a unit test could pin: `scripts/` is the pack
 * builder (whose output the pack suite asserts against, end to end), `browser.ts`
 * has its own Playwright lane as well as unit tests, and `testing.ts` is the
 * fixture kit every other suite here uses.
 */
export default mergeConfig(
  mergeConfig(defineConfig(vitestBaseConfig), defineConfig({ test: { name: "@montaj/fonts" } })),
  mergeConfig(
    defineConfig({
      test: {
        testTimeout: 60_000,
        hookTimeout: 120_000,
        coverage: {
          exclude: [
            "**/dist/**",
            "**/pack/**",
            "**/*.test.ts",
            "**/*.d.ts",
            "**/*.config.*",
            "**/index.ts",
            "src/node.ts",
            "src/testing.ts",
            "scripts/**",
            "e2e/**",
          ],
        },
      },
    }),
    defineConfig(coverageThresholds({ lines: 90, branches: 85, functions: 90, statements: 90 })),
  ),
);
