import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

/**
 * CONTRACTS §9: `apps/worker-media` is 75/70 (lines/branches).
 *
 * The integration suite (`test/**`) is excluded from coverage but not from the
 * run: it needs Redis, MinIO and a real ffmpeg, and it skips loudly when any of
 * them is missing, so counting its lines would make the gate depend on whether
 * Docker happened to be up.
 */
const withSettings = mergeConfig(
  defineConfig(vitestBaseConfig),
  defineConfig({
    test: {
      name: "@montaj/worker-media",
      include: ["src/**/*.test.ts", "test/**/*.e2e-spec.ts"],
      testTimeout: 30_000,
      hookTimeout: 180_000,
      coverage: {
        exclude: [
          "**/dist/**",
          "**/*.test.ts",
          "**/*.config.*",
          "**/index.ts",
          // Process entry point: exercised by `pnpm dev` and the e2e suite.
          "src/logger.ts",
          "test/**",
        ],
      },
    },
  }),
);

export default mergeConfig(
  withSettings,
  defineConfig(coverageThresholds({ lines: 75, branches: 70 })),
);
