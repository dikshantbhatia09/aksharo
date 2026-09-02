import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

/**
 * `docs/CONTRACTS.md` §9 puts `packages/render-core` at 90/85.
 *
 * The excluded files carry no runtime logic worth a test: `layout/types.ts` and
 * `fonts/types.ts` are interface declarations that compile to nothing, and
 * `scripts/` is the golden regeneration tool, which the golden suite exercises
 * end to end anyway.
 */
export default mergeConfig(
  mergeConfig(defineConfig(vitestBaseConfig), defineConfig({ test: { name: "@montaj/render-core" } })),
  mergeConfig(
    defineConfig({
      test: {
        coverage: {
          exclude: [
            "**/dist/**",
            "**/*.test.ts",
            "**/*.config.*",
            "**/index.ts",
            "scripts/**",
            "src/fonts/types.ts",
            "src/layout/types.ts",
          ],
        },
      },
    }),
    defineConfig(coverageThresholds({ lines: 90, branches: 85, functions: 90, statements: 90 })),
  ),
);
