import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

/**
 * `docs/CONTRACTS.md` §9 puts `apps/render` at 75/70.
 *
 * The pipeline suite generates a clip with ffmpeg and renders it end to end, so
 * the default timeout is nowhere near enough. `src/testing.ts` is fixtures and
 * `src/index.ts` is the boot wiring — both are exercised by running the service,
 * not by a unit test, so neither is counted.
 */
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig({
      test: {
        name: "@montaj/render",
        testTimeout: 600_000,
        hookTimeout: 600_000,
        // B10b/B20b: each package's own parity gate has its own unit test
        // under `parity/**` (its file boundary), alongside `src/**`/`tests/**`.
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
          exclude: [
            "**/dist/**",
            "**/*.test.ts",
            "**/*.config.*",
            "**/index.ts",
            "scripts/**",
            "src/testing.ts",
            "src/logger.ts",
          ],
        },
      },
    }),
    defineConfig(coverageThresholds({ lines: 75, branches: 70 })),
  ),
);
