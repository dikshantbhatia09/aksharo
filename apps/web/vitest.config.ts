import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

/**
 * `docs/CONTRACTS.md` §9 puts `apps/web` at 60/50. The React components are
 * covered by the Playwright lane, not here; what these tests own is the pure
 * logic under them — the stage geometry and the ops the panels emit.
 */
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig({
      test: {
        name: "@montaj/web",
        // `e2e/` belongs to Playwright, not Vitest.
        include: ["lib/**/*.test.ts", "components/**/*.test.ts"],
        coverage: {
          include: ["lib/**/*.ts", "components/**/*.ts"],
          exclude: ["**/*.test.ts", "**/*.tsx", "**/index.ts"],
        },
      },
    }),
  ),
  defineConfig(coverageThresholds({ lines: 60, branches: 50, functions: 60, statements: 60 })),
);
