import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

/** `docs/CONTRACTS.md` §9 puts `packages/ass-exporter` at 90/85. */
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig({
      test: {
        name: "@montaj/ass-exporter",
        testTimeout: 30_000,
        include: [
          "src/**/*.{test,spec}.{ts,tsx}",
          "tests/**/*.{test,spec}.{ts,tsx}",
          "parity/**/*.{test,spec}.{ts,tsx}",
        ],
      },
    }),
  ),
  mergeConfig(
    defineConfig({
      test: {
        coverage: {
          exclude: ["**/dist/**", "**/*.test.ts", "**/*.config.*", "parity/**", "scripts/**"],
        },
      },
    }),
    defineConfig(coverageThresholds({ lines: 90, branches: 85 })),
  ),
);
