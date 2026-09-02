import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

/**
 * `docs/CONTRACTS.md` §9 puts `packages/render-skia-node` at 90/85.
 *
 * The parity suite loads CanvasKit's wasm and rasterises nineteen frames twice,
 * so the default timeout is not enough on a cold cache.
 */
export default mergeConfig(
  mergeConfig(
    defineConfig(vitestBaseConfig),
    defineConfig({
      test: { name: "@montaj/render-skia-node", testTimeout: 120_000, hookTimeout: 180_000 },
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
          ],
        },
      },
    }),
    defineConfig(coverageThresholds({ lines: 90, branches: 85 })),
  ),
);
