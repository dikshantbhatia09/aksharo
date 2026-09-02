import { defineConfig, mergeConfig } from "vitest/config";

import { coverageThresholds, vitestBaseConfig } from "@montaj/config/vitest";

const withSettings = mergeConfig(
  defineConfig(vitestBaseConfig),
  defineConfig({
    test: {
      name: "@montaj/desktop",
      root: "./",
      // Adds scripts/**/*.test.mjs (bundle.mjs's own unit test, C00b) to the
      // shared src/**/tests/** include patterns — it lives next to bundle.mjs
      // rather than under src/ since it isn't part of the TS build graph.
      include: [
        "src/**/*.{test,spec}.{ts,tsx}",
        "tests/**/*.{test,spec}.{ts,tsx}",
        "scripts/**/*.{test,spec}.mjs",
      ],
    },
  }),
);

// New package (CONTRACTS §9 asks each WP that creates a package to set a
// threshold); desktop's testable surface is the pure allowlist / deep-link /
// updater-feed logic — main/preload wiring itself needs a real Electron
// runtime and is covered by the Playwright-Electron smoke suite instead.
export default mergeConfig(
  withSettings,
  defineConfig(coverageThresholds({ lines: 80, branches: 75 })),
);
